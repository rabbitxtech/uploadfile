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
import { addUsage, assertQuota, netCost, subUsage } from '../services/quota.service.js';
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

// Tolerance between the declared size and the bytes actually received, applied
// both per-part and at complete so the two checks agree.
const PART_SIZE_SLACK = 1024n;

// S3/MinIO cap a multipart upload at 10000 parts. Without an upper bound here a
// client can PUT ?part=999999: the quota check passes, the whole body is read,
// and only then does MinIO reject it deep inside uploadPart — and since
// complete() now requires the part numbers to be exactly 1..N, such a session
// can never finish, so its parts sit in MinIO until the session is aborted.
// Reject it up front, where it costs nothing.
const MAX_PART_NUMBER = 10000;

/**
 * The bytes a replace will refund at complete(), or 0n for a plain upload.
 *
 * Sums every FileVersion, not just File.size. Each version upload charges the
 * owner for its own bytes and leaves the previous version's object in MinIO, so
 * a file with history occupies the sum of its versions — which is exactly what
 * the other hard-delete paths (trash.routes.js, the retention sweep) refund.
 * Refunding only the current version leaks the older ones' bytes permanently:
 * the rows go away with the cascade and the objects are removed, but the usage
 * counter never comes back down, so the user slowly loses quota they are not
 * using and nothing can reconcile it.
 */
async function refundForSession(s) {
  if (!s.replaceFileId) return 0n;
  const old = await prisma.file.findFirst({
    where: { id: s.replaceFileId, ownerId: s.ownerId },
    select: { versions: { select: { size: true } } },
  });
  if (!old) return 0n;
  return old.versions.reduce((n, v) => n + BigInt(v.size), 0n);
}

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

    if (data.folderId) {
      const f = await prisma.folder.findFirst({
        where: { id: data.folderId, ownerId: req.user.id, trashedAt: null },
      });
      if (!f) throw notFound('Folder');
    }

    // A replace refunds the old file's bytes at complete(), so the session only
    // ever costs the difference. Resolve the target before the quota check or a
    // same-size replace is refused whenever the user is near their limit.
    if (data.replaceFileId) {
      const target = await prisma.file.findFirst({
        where: { id: data.replaceFileId, ownerId: req.user.id, trashedAt: null },
        select: { id: true },
      });
      if (!target) throw notFound('File to replace');
    }

    // Through the same helper the part and complete routes use, so all three
    // quota checks agree on what a replace is worth. Computing it inline from
    // `target.size` instead counts only the current version, which understates
    // the refund for a file with history and refuses a replace that fits.
    const refundBytes = await refundForSession({
      replaceFileId: data.replaceFileId ?? null,
      ownerId: req.user.id,
    });

    await assertQuota(req.user.id, netCost(data.size, refundBytes));

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
    if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > MAX_PART_NUMBER) {
      throw badRequest('Invalid part number');
    }

    const s = await prisma.uploadSession.findFirst({
      where: { id: req.params.id, ownerId: req.user.id },
    });
    if (!s) throw notFound('Upload session');
    if (s.completed) throw badRequest('Upload already completed');

    const body = req.body;
    if (!Buffer.isBuffer(body) || body.length === 0) throw badRequest('Empty chunk');

    // Bound the session here, not only at complete/init. init only sees the
    // *declared* size, so a client could declare 0 and then stream unlimited
    // parts: complete would refuse to create the File row, but the bytes would
    // already be sitting in MinIO. Re-uploading a part replaces it, so the
    // projected total excludes the part number being overwritten.
    const projectedWith = (partsJson) => {
      const kept = JSON.parse(partsJson).filter((p) => p.partNumber !== partNumber);
      return {
        kept,
        projected: kept.reduce((n, p) => n + BigInt(p.size || 0), 0n) + BigInt(body.length),
      };
    };

    // Same 1 KiB slack complete() allows for the last part.
    const pre = projectedWith(s.parts);
    if (pre.projected > BigInt(s.size) + PART_SIZE_SLACK) {
      throw payloadTooLarge('Uploaded bytes exceed the declared size');
    }
    await assertQuota(s.ownerId, netCost(pre.projected, await refundForSession(s)));

    const result = await uploadPart({
      key: s.objectKey,
      uploadId: s.uploadId,
      partNumber,
      body,
      length: body.length,
    });

    // Record the part with optimistic concurrency. `parts` is a JSON *string*
    // (SQLite/MySQL portability), so it can only be rewritten wholesale — and a
    // plain read-modify-write loses parts when two PUTs overlap: both read the
    // same list, and the second write drops the first one's entry. That failure
    // is silent and corrupting, because the size check at complete() is only an
    // upper bound — an object assembled from a parts list with a hole passes it
    // and is stored truncated. Gate the write on the exact string we based the
    // new list on, and re-read on contention. The client uploads sequentially,
    // so this loop is not hit in normal use; it exists for retries and for any
    // client that parallelises.
    let stored = null;
    let current = s;
    for (let attempt = 0; attempt < 5 && !stored; attempt++) {
      const { kept, projected } = projectedWith(current.parts);
      // Re-check the bound against the list we are actually extending: a part
      // that raced in since our first read counts toward the declared size too.
      if (projected > BigInt(current.size) + PART_SIZE_SLACK) {
        throw payloadTooLarge('Uploaded bytes exceed the declared size');
      }
      const next = JSON.stringify([...kept, result]);
      const written = await prisma.uploadSession.updateMany({
        where: { id: current.id, parts: current.parts, completed: false },
        data: { parts: next },
      });
      if (written.count > 0) {
        stored = next;
        break;
      }
      const fresh = await prisma.uploadSession.findFirst({
        where: { id: s.id, ownerId: req.user.id },
      });
      if (!fresh) throw notFound('Upload session');
      if (fresh.completed) throw badRequest('Upload already completed');
      current = fresh;
    }
    if (!stored) throw badRequest('Upload session is busy, retry this part');

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

    // Aborting releases the parts in MinIO, but the session row survives and
    // still holds the now-dead uploadId. Marking it completed stops a client
    // retrying complete() against an upload MinIO has already discarded (which
    // would fail with NoSuchUpload) and stops DELETE /:id aborting it twice.
    const failSession = async () => {
      await abortMultipart(s.objectKey, s.uploadId);
      await prisma.uploadSession
        .update({ where: { id: s.id }, data: { completed: true } })
        .catch(() => {});
    };

    if (BigInt(total) > BigInt(s.size) + PART_SIZE_SLACK) {
      // Release the reserved multipart upload — otherwise the already-uploaded
      // parts stay in MinIO, billed to nobody and cleaned up by nothing.
      await failSession();
      throw badRequest('Uploaded bytes do not match declared size');
    }

    // The size check above is only an UPPER bound, so on its own it accepts an
    // incomplete upload: parts 1,2,4 (part 3 never sent, or lost) total less
    // than the declared size and sail through, and completeMultipart happily
    // assembles the pieces that *are* present. The result is a File row whose
    // recorded size matches the bytes stored but whose content is silently
    // truncated — the worst kind of failure, since nothing errors and the user
    // only discovers it when the file will not open. Require the part numbers
    // to be exactly 1..N, and the byte total to actually reach the declared
    // size (same slack, applied downward).
    const numbers = parts.map((p) => p.partNumber).sort((a, b) => a - b);
    const contiguous = numbers.every((n, i) => n === i + 1);
    if (!contiguous) {
      await failSession();
      throw badRequest('Upload is incomplete: missing one or more parts');
    }
    if (BigInt(total) + PART_SIZE_SLACK < BigInt(s.size)) {
      await failSession();
      throw badRequest('Uploaded bytes do not match declared size');
    }

    // Final quota check using the actual bytes, net of what a replace refunds.
    const refundBytes = await refundForSession(s);
    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (BigInt(user.usedBytes) + netCost(total, refundBytes) > BigInt(user.quotaBytes)) {
      await failSession();
      throw payloadTooLarge();
    }

    await completeMultipart(s.objectKey, s.uploadId, parts);

    // If this is a replace: remove the old File row (versions cascade) and
    // refund its bytes, then create the new File with the same name/folder. The
    // old MinIO objects are best-effort removed after.
    //
    // Every version is refunded and removed, not just the current one — each
    // version upload charged the owner separately and left its object behind, so
    // the file occupies the sum of its versions. This mirrors the manual
    // hard-delete in trash.routes.js and the retention sweep; refunding only
    // File.size would strand the older versions' bytes in the usage counter
    // forever, and leaving their objects behind would strand them in MinIO.
    let oldObjectKeys = [];
    let oldSizeBytes = 0n;
    if (s.replaceFileId) {
      const old = await prisma.file.findFirst({
        where: { id: s.replaceFileId, ownerId: req.user.id },
        include: { versions: true },
      });
      if (old) {
        // A Set because the current version's objectKey is normally also the
        // newest FileVersion's — removing the same key twice is harmless, but
        // double-counting its size in the refund is not.
        const keys = new Set(old.versions.map((v) => v.objectKey));
        keys.add(old.objectKey);
        // The thumbnail is derived data outside the quota, but it is still an
        // object nothing else will ever reference once this row is gone.
        if (old.thumbnailKey) keys.add(old.thumbnailKey);
        oldObjectKeys = [...keys];
        oldSizeBytes = old.versions.reduce((n, v) => n + BigInt(v.size), 0n);
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
    if (oldObjectKeys.length) {
      for (const key of oldObjectKeys) {
        removeObject(key).catch((e) =>
          console.warn('[upload] failed to remove replaced object:', e?.message),
        );
      }
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
