// Share links: create/list/revoke for files (and folder zip), public access via token.
import { Router } from 'express';
import multer from 'multer';
import bcrypt from 'bcryptjs';
import archiver from 'archiver';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { prisma } from '../config/prisma.js';
import { env } from '../config/env.js';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../utils/async.js';
import { badRequest, conflict, forbidden, notFound } from '../utils/errors.js';
import { findFolderNameClash, sanitizeEntryName, zipEntryName } from '../utils/namecollision.js';
import { getObjectStream, putObjectStream, objectKeyFor } from '../services/storage.service.js';
import { assertQuota, addUsage } from '../services/quota.service.js';
import { sha256Buffer } from '../services/checksum.service.js';
import { indexFile } from '../services/ai.service.js';
import { canThumbnail, generateThumbnail } from '../services/thumbnail.service.js';
import { canVideoThumbnail, generateVideoThumbnail } from '../services/video.service.js';
import { notify } from '../services/notify.service.js';
import { emitFileChange } from '../realtime/bus.js';
import { publicLimiter, uploadLimiter } from '../middleware/ratelimit.js';
import { audit, clientIp } from '../services/audit.service.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });

// B7 — record a public access on a share (best-effort).
function logShareAccess(shareId, action, req) {
  prisma.shareAccess
    .create({
      data: { shareId, action, ip: clientIp(req), userAgent: (req.headers['user-agent'] || '').slice(0, 300) },
    })
    .catch(() => {});
}

router.use('/public', publicLimiter); // B5 — rate limit public share endpoints

// ---- public endpoints (no auth) ----

// Build the full (unlocked) share payload, including the folder's file listing.
// Only call this once the share is known to be accessible (no password, or the
// correct password was supplied) — it logs a 'view' and reveals contents.
async function buildShareInfo(share, req) {
  let folder = null;
  let files = null;
  if (share.folderId) {
    folder = await prisma.folder.findUnique({
      where: { id: share.folderId },
      select: { id: true, name: true, path: true },
    });
    const list = await prisma.file.findMany({
      where: { folderId: share.folderId, trashedAt: null },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, mimeType: true, size: true, hasPreview: true },
    });
    files = list.map((f) => ({
      id: f.id,
      name: f.name,
      mimeType: f.mimeType,
      size: f.size.toString(),
      hasPreview: f.hasPreview,
    }));
  }

  logShareAccess(share.id, 'view', req); // B7
  return {
    id: share.id,
    hasPassword: !!share.password,
    locked: false,
    expiresAt: share.expiresAt,
    allowUpload: share.allowUpload && !!share.folderId,
    remainingDownloads:
      share.maxDownloads != null ? Math.max(0, share.maxDownloads - share.downloads) : null,
    file: share.file
      ? {
          id: share.file.id,
          name: share.file.name,
          mimeType: share.file.mimeType,
          size: share.file.size.toString(),
          hasPreview: share.file.hasPreview,
        }
      : null,
    folder,
    files,
  };
}

router.get(
  '/public/:token',
  asyncHandler(async (req, res) => {
    const share = await prisma.share.findUnique({
      where: { token: req.params.token },
      include: {
        file: { include: { tags: true } },
      },
    });
    if (!share) throw notFound('Share');
    await assertShareTargetLive(share);
    if (share.expiresAt && share.expiresAt < new Date()) throw forbidden('Share expired');
    if (share.maxDownloads && share.downloads >= share.maxDownloads) {
      throw forbidden('Share download limit reached');
    }

    // Password-protected shares must not leak their contents (file name/size or
    // the folder's file list) before the password is supplied — the client
    // unlocks via POST /public/:token/unlock. Return metadata only.
    if (share.password) {
      logShareAccess(share.id, 'view', req); // B7
      return res.json({
        id: share.id,
        hasPassword: true,
        locked: true,
        isFolder: !!share.folderId,
        expiresAt: share.expiresAt,
        allowUpload: share.allowUpload && !!share.folderId,
        remainingDownloads:
          share.maxDownloads != null ? Math.max(0, share.maxDownloads - share.downloads) : null,
        file: null,
        folder: null,
        files: null,
      });
    }

    res.json(await buildShareInfo(share, req));
  }),
);

// Unlock a password-protected share: verify the password, then return the full
// payload (file metadata / folder listing). Mirrors the password check used by
// the download endpoint so the listing can't be read without it.
router.post(
  '/public/:token/unlock',
  asyncHandler(async (req, res) => {
    const share = await prisma.share.findUnique({
      where: { token: req.params.token },
      include: { file: { include: { tags: true } } },
    });
    await authorizeShare(share, req.body?.password);
    res.json(await buildShareInfo(share, req));
  }),
);

/**
 * A share must stop working once its target is trashed — trashing is the user's
 * "un-share it" action. Treated as 404 (not 403) to match how the rest of the
 * public surface refuses to confirm what a token points at.
 *
 * `share.file` must be loaded by the caller for a FILE share. Distinguishing
 * "not included" from "row is gone" matters: reading a missing relation as a
 * dead file would 404 every *live* file share made through a caller that didn't
 * `include` it, so that mistake fails closed on the wrong side. Throw instead —
 * it turns a future caller's missing `include` into a loud 500 during
 * development rather than a share link that mysteriously stops resolving in
 * production.
 *
 * A FOLDER share owes the same rule, and the listing filter is NOT a substitute
 * for it. Trashing a folder stamps its files trashed too, so the listing does
 * come back empty — but the link itself stayed alive: it kept resolving, kept
 * reporting the folder's name and path, and (for an `allowUpload` drop-box)
 * kept ACCEPTING anonymous uploads into a folder the owner had deleted, where
 * the new file lands live inside a trashed parent and so is reachable from
 * neither the file listing nor the trash view — the same unreachable-row state
 * the restore-ancestor walk exists to prevent, except here anyone holding the
 * link can create it. The folder is a separate row that has to be read, so this
 * is async; the file branch stays a pure check on the included relation.
 */
async function assertShareTargetLive(share) {
  if (share.folderId) {
    const folder = await prisma.folder.findFirst({
      where: { id: share.folderId, trashedAt: null },
      select: { id: true },
    });
    if (!folder) throw notFound('Share');
    return;
  }
  if (!share.fileId) return;
  if (share.file === undefined) {
    throw new Error('assertShareTargetLive: share.file was not included by the caller');
  }
  if (!share.file || share.file.trashedAt) throw notFound('Share');
}

async function authorizeShare(share, providedPassword) {
  if (!share) throw notFound('Share');
  await assertShareTargetLive(share);
  if (share.expiresAt && share.expiresAt < new Date()) throw forbidden('Share expired');
  if (share.maxDownloads != null && share.downloads >= share.maxDownloads) {
    throw forbidden('Share download limit reached');
  }
  if (share.password) {
    if (!providedPassword) throw forbidden('Password required');
    const ok = await bcrypt.compare(providedPassword, share.password);
    if (!ok) throw forbidden('Wrong password');
  }
}

router.post(
  '/public/:token/download',
  asyncHandler(async (req, res) => {
    const share = await prisma.share.findUnique({
      where: { token: req.params.token },
      include: { file: true },
    });
    await authorizeShare(share, req.body?.password);
    logShareAccess(share.id, 'download', req); // B7

    if (share.fileId && share.file) {
      res.setHeader('Content-Type', share.file.mimeType);
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${encodeURIComponent(share.file.name)}"`,
      );
      const stream = await getObjectStream(share.file.objectKey);
      stream.on('error', (e) => res.destroy(e));
      stream.pipe(res);
      stream.on('end', () => {
        prisma.share
          .update({ where: { id: share.id }, data: { downloads: { increment: 1 } } })
          .catch(() => {});
        notify(share.ownerId, {
          type: 'share_download',
          title: `Your shared file was downloaded`,
          body: `"${share.file.name}" was downloaded via your share link.`,
          link: '/shares',
        });
      });
      return;
    }

    if (share.folderId) {
      if (!env.zipDownloadEnabled) throw forbidden('ZIP download is temporarily disabled');
      const folder = await prisma.folder.findUnique({
        where: { id: share.folderId },
        select: { name: true },
      });
      const files = await prisma.file.findMany({
        where: { folderId: share.folderId, trashedAt: null },
      });
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="folder-${share.token}.zip"`);
      const archive = archiver('zip', { zlib: { level: 6 } });
      archive.on('error', (e) => res.destroy(e));
      archive.pipe(res);
      // One segment per entry — a stored name with "/" or ".." is a Zip Slip
      // entry, and this archive goes to an anonymous link holder. See
      // zipEntryName for why the reader sanitises as well as the writers.
      for (const f of files) {
        const s = await getObjectStream(f.objectKey);
        archive.append(s, { name: zipEntryName(f.name) });
      }
      await archive.finalize();
      await prisma.share.update({
        where: { id: share.id },
        data: { downloads: { increment: 1 } },
      });
      notify(share.ownerId, {
        type: 'share_download',
        title: `Your shared folder was downloaded`,
        body: `"${folder?.name || 'A folder'}" was downloaded as ZIP via your share link.`,
        link: '/shares',
      });
      return;
    }
    throw notFound('Share target');
  }),
);

// I1 — anonymous upload into a folder via an upload-request link. No auth; the
// uploaded file is owned by (and counts against the quota of) the link owner.
router.post(
  '/public/:token/upload',
  uploadLimiter, // Task 15 — strict per-IP rate limit on anonymous uploads
  upload.single('file'),
  asyncHandler(async (req, res) => {
    if (!req.file) throw badRequest('No file uploaded');
    const share = await prisma.share.findUnique({ where: { token: req.params.token } });
    if (!share) throw notFound('Share');
    if (!share.allowUpload || !share.folderId) throw forbidden('Uploads not allowed for this link');
    // Same liveness rule the read paths apply: a drop-box on a trashed folder
    // must not keep accepting anonymous uploads. The folder lookup below already
    // filters `trashedAt: null`, but it 404s AFTER the password check and the
    // per-share caps, so run the shared assertion first and refuse identically
    // to every other dead-target case.
    await assertShareTargetLive(share);
    if (share.expiresAt && share.expiresAt < new Date()) throw forbidden('Share expired');
    if (share.password) {
      const ok = req.body?.password && (await bcrypt.compare(req.body.password, share.password));
      if (!ok) throw forbidden('Password required');
    }

    // Task 15 — anti-abuse caps on the drop-box.
    const maxBytes = env.limits.dropboxMaxFileBytes;
    if (maxBytes > 0 && req.file.size > maxBytes) {
      throw badRequest(`File too large for this upload link (max ${Math.floor(maxBytes / (1024 * 1024))} MB)`);
    }
    const maxUploads = env.limits.dropboxMaxUploadsPerShare;
    if (maxUploads > 0) {
      const used = await prisma.shareAccess.count({ where: { shareId: share.id, action: 'upload' } });
      if (used >= maxUploads) throw forbidden('This upload link has reached its file limit');
    }

    const folder = await prisma.folder.findFirst({
      where: { id: share.folderId, trashedAt: null },
    });
    if (!folder) throw notFound('Folder');

    // The multipart filename is fully attacker-controlled here — this endpoint
    // takes no authentication at all — so reduce it to one segment before it is
    // stored. A dropped "a/b.txt" would otherwise land a row the link owner
    // cannot resolve over WebDAV, and "../x" would ride into their next ZIP
    // download as a Zip Slip entry. See sanitizeEntryName.
    const dropName = sanitizeEntryName(req.file.originalname, {
      label: 'filename',
      mode: 'strip',
    });

    // A dropped file must not take a live SUBFOLDER's name: WebDAV resolves a
    // path segment by trying the folder first, so the upload would be live and
    // billed against the link owner while being unreadable and undeletable there.
    // The link owner is not present to resolve it, and an anonymous uploader has
    // no way to know the folder exists, so refuse rather than rename.
    if (await findFolderNameClash(share.ownerId, folder.id, dropName)) {
      throw conflict('A folder with that name already exists here');
    }

    await assertQuota(share.ownerId, req.file.size);

    const ext = dropName.includes('.') ? dropName.split('.').pop() : '';
    const key = objectKeyFor(share.ownerId, ext);
    await putObjectStream(key, req.file.buffer, req.file.size, req.file.mimetype);
    const checksum = sha256Buffer(req.file.buffer);

    const file = await prisma.file.create({
      data: {
        name: dropName,
        originalName: dropName,
        mimeType: req.file.mimetype,
        size: BigInt(req.file.size),
        objectKey: key,
        bucket: process.env.MINIO_BUCKET || 'uploads',
        checksum,
        folderId: folder.id,
        ownerId: share.ownerId,
        versions: { create: { version: 1, objectKey: key, size: BigInt(req.file.size), checksum } },
      },
    });
    await addUsage(share.ownerId, req.file.size);

    if (canThumbnail(req.file.mimetype)) {
      generateThumbnail(key, req.file.mimetype)
        .then((thumbKey) => thumbKey && prisma.file.update({ where: { id: file.id }, data: { thumbnailKey: thumbKey, hasPreview: true } }))
        .catch(() => {});
    } else if (canVideoThumbnail(req.file.mimetype)) {
      generateVideoThumbnail(key, req.file.mimetype)
        .then((thumbKey) => thumbKey && prisma.file.update({ where: { id: file.id }, data: { thumbnailKey: thumbKey, hasPreview: true } }))
        .catch(() => {});
    }

    indexFile(file.id); // K1/K4
    logShareAccess(share.id, 'upload', req); // B7

    notify(share.ownerId, {
      type: 'upload_received',
      title: `New file uploaded to "${folder.name}"`,
      body: `"${dropName}" was uploaded via your upload link.`,
      link: '/files',
    });
    emitFileChange(share.ownerId, folder.id); // Task5 #5

    res.status(201).json({ ok: true, name: file.name });
  }),
);

// ---- authenticated endpoints ----
router.use(requireAuth);

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const shares = await prisma.share.findMany({
      where: { ownerId: req.user.id },
      orderBy: { createdAt: 'desc' },
      include: { file: { select: { id: true, name: true } } },
    });
    // Hydrate folder names for folder shares
    const folderIds = [...new Set(shares.filter((s) => s.folderId).map((s) => s.folderId))];
    const folders = folderIds.length
      ? await prisma.folder.findMany({
          where: { id: { in: folderIds } },
          select: { id: true, name: true, path: true },
        })
      : [];
    const folderById = new Map(folders.map((f) => [f.id, f]));
    const hydrated = shares.map((s) => ({
      ...s,
      folder: s.folderId ? folderById.get(s.folderId) || null : null,
    }));
    res.json({ shares: hydrated });
  }),
);

router.post(
  '/',
  asyncHandler(async (req, res) => {
    const data = z
      .object({
        fileId: z.string().optional(),
        folderId: z.string().optional(),
        label: z.string().trim().max(120).optional(),
        password: z.string().min(1).optional(),
        expiresAt: z.string().datetime().optional(),
        maxDownloads: z.number().int().positive().optional(),
        allowUpload: z.boolean().optional(),
      })
      .refine((d) => !!d.fileId || !!d.folderId, { message: 'fileId or folderId required' })
      .parse(req.body);

    // Task 15 — cap active share links per user (admins exempt; 0 = unlimited).
    const cap = env.limits.maxSharesPerUser;
    if (cap > 0 && req.user.role !== 'admin') {
      const active = await prisma.share.count({ where: { ownerId: req.user.id } });
      if (active >= cap) throw forbidden(`Share limit reached (max ${cap}). Revoke an old share first.`);
    }

    if (data.fileId) {
      const f = await prisma.file.findFirst({
        where: { id: data.fileId, ownerId: req.user.id, trashedAt: null },
      });
      if (!f) throw notFound('File');
    }
    if (data.folderId) {
      const f = await prisma.folder.findFirst({
        where: { id: data.folderId, ownerId: req.user.id, trashedAt: null },
      });
      if (!f) throw notFound('Folder');
    }

    const share = await prisma.share.create({
      data: {
        token: nanoid(16),
        fileId: data.fileId ?? null,
        folderId: data.folderId ?? null,
        ownerId: req.user.id,
        label: data.label || null,
        password: data.password ? await bcrypt.hash(data.password, 10) : null,
        expiresAt: data.expiresAt ? new Date(data.expiresAt) : null,
        maxDownloads: data.maxDownloads ?? null,
        allowUpload: !!data.allowUpload && !!data.folderId,
      },
    });
    audit('share_create', {
      userId: req.user.id,
      targetType: data.fileId ? 'file' : 'folder',
      targetId: data.fileId || data.folderId,
      meta: { token: share.token, allowUpload: share.allowUpload },
      ip: clientIp(req),
    });
    res.status(201).json(share);
  }),
);

// Task5 #15 — update a share's label or expiry ("extend" an expiring link).
// expiresAt: ISO datetime to set, or null to remove the expiry.
router.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const data = z
      .object({
        label: z.string().trim().max(120).nullable().optional(),
        expiresAt: z.string().datetime().nullable().optional(),
      })
      .parse(req.body);
    const s = await prisma.share.findFirst({ where: { id: req.params.id, ownerId: req.user.id } });
    if (!s) throw notFound('Share');
    const updated = await prisma.share.update({
      where: { id: s.id },
      data: {
        label: data.label !== undefined ? data.label || null : undefined,
        expiresAt: data.expiresAt !== undefined ? (data.expiresAt ? new Date(data.expiresAt) : null) : undefined,
      },
    });
    audit('share_update', {
      userId: req.user.id,
      targetType: 'share',
      targetId: s.id,
      meta: { label: updated.label, expiresAt: updated.expiresAt },
      ip: clientIp(req),
    });
    res.json(updated);
  }),
);

// B7 — owner views the access log + summary for one of their shares.
router.get(
  '/:id/access',
  asyncHandler(async (req, res) => {
    const s = await prisma.share.findFirst({ where: { id: req.params.id, ownerId: req.user.id } });
    if (!s) throw notFound('Share');
    const accesses = await prisma.shareAccess.findMany({
      where: { shareId: s.id },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    const summary = accesses.reduce((acc, a) => ((acc[a.action] = (acc[a.action] || 0) + 1), acc), {});
    res.json({ accesses, summary, total: accesses.length });
  }),
);

router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const s = await prisma.share.findFirst({
      where: { id: req.params.id, ownerId: req.user.id },
    });
    if (!s) throw notFound('Share');
    await prisma.share.delete({ where: { id: s.id } });
    audit('share_revoke', { userId: req.user.id, targetType: 'share', targetId: s.id, ip: clientIp(req) });
    res.json({ ok: true });
  }),
);

export default router;
