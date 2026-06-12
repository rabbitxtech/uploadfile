// Chunked / resumable upload using MinIO multipart.
// Flow:
//   POST   /api/upload/init           -> create session, returns { sessionId, chunkSize }
//   PUT    /api/upload/:id/part?part=N (raw body)  -> upload one chunk
//   POST   /api/upload/:id/complete   -> finalize, returns File
//   GET    /api/upload/:id            -> resume info (list uploaded parts)
//   DELETE /api/upload/:id            -> abort + cleanup
import { Router } from 'express';
import express from 'express';
import { z } from 'zod';
import { prisma } from '../config/prisma.js';
import { requireAuth, requireApproved } from '../middleware/auth.js';
import { asyncHandler } from '../utils/async.js';
import { badRequest, notFound, payloadTooLarge } from '../utils/errors.js';
import {
  abortMultipart,
  completeMultipart,
  initiateMultipart,
  objectKeyFor,
  removeObject,
  uploadPart,
} from '../services/storage.service.js';
import { addUsage, assertQuota, subUsage } from '../services/quota.service.js';
import { generateThumbnail, canThumbnail } from '../services/thumbnail.service.js';
import { canVideoThumbnail, generateVideoThumbnail } from '../services/video.service.js';
import { backfillChecksum } from '../services/checksum.service.js';
import { indexFile } from '../services/ai.service.js';
import { postProcessMedia } from '../services/media.service.js';
import { removeHls } from '../services/hls.service.js';
import { emitFileChange } from '../realtime/bus.js';

const router = Router();
router.use(requireAuth);

const CHUNK_SIZE = 8 * 1024 * 1024; // 8 MiB recommended for MinIO multipart

router.post(
  '/init',
  requireApproved,
  asyncHandler(async (req, res) => {
    const data = z
      .object({
        filename: z.string().min(1).max(512),
        size: z.coerce.number().int().nonnegative(),
        mimeType: z.string().default('application/octet-stream'),
        folderId: z.string().nullable().optional(),
        replaceFileId: z.string().nullable().optional(),
      })
      .parse(req.body);

    await assertQuota(req.user.id, data.size);

    if (data.folderId) {
      const f = await prisma.folder.findFirst({
        where: { id: data.folderId, ownerId: req.user.id, trashedAt: null },
      });
      if (!f) throw notFound('Folder');
    }

    if (data.replaceFileId) {
      const target = await prisma.file.findFirst({
        where: { id: data.replaceFileId, ownerId: req.user.id, trashedAt: null },
      });
      if (!target) throw notFound('File to replace');
    }

    const ext = data.filename.includes('.') ? data.filename.split('.').pop() : '';
    const objectKey = objectKeyFor(req.user.id, ext);
    const uploadId = await initiateMultipart(objectKey, data.mimeType);

    const session = await prisma.uploadSession.create({
      data: {
        ownerId: req.user.id,
        filename: data.filename,
        size: BigInt(data.size),
        mimeType: data.mimeType,
        folderId: data.folderId ?? null,
        uploadId,
        objectKey,
        replaceFileId: data.replaceFileId ?? null,
      },
    });
    res.status(201).json({ sessionId: session.id, chunkSize: CHUNK_SIZE });
  }),
);

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const s = await prisma.uploadSession.findFirst({
      where: { id: req.params.id, ownerId: req.user.id },
    });
    if (!s) throw notFound('Upload session');
    res.json({
      sessionId: s.id,
      filename: s.filename,
      size: s.size.toString(),
      uploaded: JSON.parse(s.parts).map((p) => p.partNumber),
      chunkSize: CHUNK_SIZE,
      completed: s.completed,
    });
  }),
);

// Raw body of a chunk; the route consumes the body manually using express.raw.
router.put(
  '/:id/part',
  express.raw({ type: '*/*', limit: '64mb' }),
  asyncHandler(async (req, res) => {
    const partNumber = parseInt(String(req.query.part || ''), 10);
    if (!Number.isInteger(partNumber) || partNumber < 1) throw badRequest('Invalid part number');

    const s = await prisma.uploadSession.findFirst({
      where: { id: req.params.id, ownerId: req.user.id },
    });
    if (!s) throw notFound('Upload session');
    if (s.completed) throw badRequest('Upload already completed');

    const body = req.body;
    if (!Buffer.isBuffer(body) || body.length === 0) throw badRequest('Empty chunk');

    const result = await uploadPart({
      key: s.objectKey,
      uploadId: s.uploadId,
      partNumber,
      body,
      length: body.length,
    });

    // Update parts list (dedup by partNumber so resumed uploads overwrite cleanly)
    const parts = JSON.parse(s.parts);
    const filtered = parts.filter((p) => p.partNumber !== partNumber);
    filtered.push(result);
    await prisma.uploadSession.update({
      where: { id: s.id },
      data: { parts: JSON.stringify(filtered) },
    });

    res.json({ partNumber, etag: result.etag, size: result.size });
  }),
);

router.post(
  '/:id/complete',
  asyncHandler(async (req, res) => {
    const s = await prisma.uploadSession.findFirst({
      where: { id: req.params.id, ownerId: req.user.id },
    });
    if (!s) throw notFound('Upload session');
    if (s.completed) throw badRequest('Already completed');

    const parts = JSON.parse(s.parts);
    if (parts.length === 0) throw badRequest('No parts uploaded');

    const total = parts.reduce((n, p) => n + (p.size || 0), 0);
    if (BigInt(total) > BigInt(s.size) + BigInt(1024)) {
      // slight slack for last part
      throw badRequest('Uploaded bytes do not match declared size');
    }

    // Final quota check using actual bytes
    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (BigInt(user.usedBytes) + BigInt(total) > BigInt(user.quotaBytes)) {
      await abortMultipart(s.objectKey, s.uploadId);
      throw payloadTooLarge();
    }

    await completeMultipart(s.objectKey, s.uploadId, parts);

    // If this is a replace, atomically: remove old File row (+versions) and
    // refund its bytes to the user's quota, then create the new File with the
    // same name/folder. The old MinIO object is best-effort removed after.
    let oldObjectKey = null;
    let oldSizeBytes = 0n;
    if (s.replaceFileId) {
      const old = await prisma.file.findFirst({
        where: { id: s.replaceFileId, ownerId: req.user.id },
      });
      if (old) {
        oldObjectKey = old.objectKey;
        oldSizeBytes = old.size;
        await prisma.file.delete({ where: { id: old.id } });
      }
    }

    const file = await prisma.file.create({
      data: {
        name: s.filename,
        originalName: s.filename,
        mimeType: s.mimeType,
        size: BigInt(total),
        objectKey: s.objectKey,
        bucket: process.env.MINIO_BUCKET || 'uploads',
        folderId: s.folderId,
        ownerId: req.user.id,
        versions: {
          create: {
            version: 1,
            objectKey: s.objectKey,
            size: BigInt(total),
          },
        },
      },
      include: { tags: true, versions: true, owner: { select: { id: true, name: true, email: true } } },
    });

    await addUsage(req.user.id, total);
    if (oldSizeBytes > 0n) await subUsage(req.user.id, oldSizeBytes);
    if (oldObjectKey) {
      removeObject(oldObjectKey).catch((e) =>
        console.warn('[upload] failed to remove replaced object:', e?.message),
      );
      removeHls(s.replaceFileId).catch(() => {}); // drop the replaced file's renditions
    }

    await prisma.uploadSession.update({
      where: { id: s.id },
      data: { completed: true },
    });

    // Checksum (best-effort, async) — streams the assembled object (H2 dedup).
    backfillChecksum(file.id, s.objectKey);
    indexFile(file.id); // K1/K4 — OCR + embedding (async, best-effort)

    // Thumbnail (best-effort, async) — image via sharp, video poster via ffmpeg.
    if (canThumbnail(s.mimeType)) {
      generateThumbnail(s.objectKey, s.mimeType)
        .then((thumbKey) => {
          if (thumbKey) {
            return prisma.file.update({
              where: { id: file.id },
              data: { thumbnailKey: thumbKey, hasPreview: true },
            });
          }
        })
        .catch((e) => console.warn('[thumb] failed:', e?.message));
    } else if (canVideoThumbnail(s.mimeType)) {
      generateVideoThumbnail(s.objectKey, s.mimeType)
        .then((thumbKey) => {
          if (thumbKey) {
            return prisma.file.update({
              where: { id: file.id },
              data: { thumbnailKey: thumbKey, hasPreview: true },
            });
          }
        })
        .catch((e) => console.warn('[vthumb] failed:', e?.message));
    }

    // Fast-start remux → HLS renditions + transcription (best-effort, async).
    postProcessMedia(file.id, s.mimeType);
    emitFileChange(req.user.id, s.folderId); // Task5 #5

    res.status(201).json(file);
  }),
);

router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const s = await prisma.uploadSession.findFirst({
      where: { id: req.params.id, ownerId: req.user.id },
    });
    if (!s) throw notFound('Upload session');
    if (!s.completed) {
      await abortMultipart(s.objectKey, s.uploadId);
      await removeObject(s.objectKey);
    }
    await prisma.uploadSession.delete({ where: { id: s.id } });
    res.json({ ok: true });
  }),
);

export default router;
