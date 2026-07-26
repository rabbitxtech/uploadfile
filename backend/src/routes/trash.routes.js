import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../config/prisma.js';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../utils/async.js';
import { notFound } from '../utils/errors.js';
import { env } from '../config/env.js';
import { removeObject } from '../services/storage.service.js';
import { removeHls } from '../services/hls.service.js';
import { subUsage } from '../services/quota.service.js';
import { deletableFolderIds } from '../utils/foldercascade.js';
import { emitFileChange } from '../realtime/bus.js';

const router = Router();
router.use(requireAuth);

// Admin can act on another user's trash via `?ownerId=`; everyone else is
// scoped to their own.
function effectiveOwnerId(req) {
  if (req.user.role === 'admin' && req.query.ownerId) return String(req.query.ownerId);
  return req.user.id;
}
// For id-targeted writes: admins may act on ANY item, users only their own.
function ownerScope(req) {
  return req.user.role === 'admin' ? {} : { ownerId: req.user.id };
}

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const ownerId = effectiveOwnerId(req);
    const [files, folders] = await Promise.all([
      prisma.file.findMany({
        where: { ownerId, trashedAt: { not: null } },
        orderBy: { trashedAt: 'desc' },
      }),
      prisma.folder.findMany({
        where: { ownerId, trashedAt: { not: null } },
        orderBy: { trashedAt: 'desc' },
      }),
    ]);
    res.json({ files, folders, retentionDays: env.trashRetentionDays });
  }),
);

router.post(
  '/restore',
  asyncHandler(async (req, res) => {
    const data = z
      .object({
        fileIds: z.array(z.string()).optional(),
        folderIds: z.array(z.string()).optional(),
      })
      .parse(req.body);

    const ops = [];
    if (data.fileIds?.length) {
      ops.push(
        prisma.file.updateMany({
          where: { id: { in: data.fileIds }, ...ownerScope(req) },
          data: { trashedAt: null },
        }),
      );
    }
    if (data.folderIds?.length) {
      ops.push(
        prisma.folder.updateMany({
          where: { id: { in: data.folderIds }, ...ownerScope(req) },
          data: { trashedAt: null },
        }),
      );
    }
    const results = await prisma.$transaction(ops);
    const restored = results.reduce((n, r) => n + r.count, 0);
    if (restored) emitFileChange(req.user.id); // Task5 #5
    res.json({ restored });
  }),
);

// Hard-delete one trashed file (also removes object + versions from MinIO).
// Quota is refunded to the file's owner (an admin may delete someone else's).
router.delete(
  '/file/:id',
  asyncHandler(async (req, res) => {
    const file = await prisma.file.findFirst({
      where: { id: req.params.id, ...ownerScope(req), trashedAt: { not: null } },
      include: { versions: true },
    });
    if (!file) throw notFound('Trashed file');

    let totalBytes = 0n;
    for (const v of file.versions) {
      await removeObject(v.objectKey);
      totalBytes += BigInt(v.size);
    }
    if (file.thumbnailKey) await removeObject(file.thumbnailKey);
    if (file.hlsReady) await removeHls(file.id);
    await prisma.file.delete({ where: { id: file.id } });
    await subUsage(file.ownerId, totalBytes);
    res.json({ ok: true });
  }),
);

router.post(
  '/empty',
  asyncHandler(async (req, res) => {
    const ownerId = effectiveOwnerId(req);
    const files = await prisma.file.findMany({
      where: { ownerId, trashedAt: { not: null } },
      include: { versions: true },
    });
    let total = 0n;
    for (const f of files) {
      for (const v of f.versions) {
        await removeObject(v.objectKey);
        total += BigInt(v.size);
      }
      if (f.thumbnailKey) await removeObject(f.thumbnailKey);
      if (f.hlsReady) await removeHls(f.id);
    }
    // Folder.parent is onDelete: Cascade, so deleting every trashed folder also
    // takes any LIVE descendant with it — and restore un-trashes only the exact
    // ids it is given, so a user who restored a child out of a trashed parent
    // still has that parent sitting in the trash. Emptying would then destroy
    // the folder they just chose to keep and orphan its files to the root
    // (File.folder is SetNull), with their bytes never refunded, because those
    // files were untrashed and so were never in the delete set above. Skip any
    // trashed folder that still has a live descendant.
    const [trashedFolders, survivors] = await Promise.all([
      prisma.folder.findMany({
        where: { ownerId, trashedAt: { not: null } },
        select: { id: true, ownerId: true, path: true },
      }),
      prisma.folder.findMany({
        where: { ownerId, trashedAt: null },
        select: { ownerId: true, path: true },
      }),
    ]);
    const deletableFolders = deletableFolderIds(trashedFolders, survivors);

    await prisma.$transaction([
      prisma.file.deleteMany({ where: { ownerId, trashedAt: { not: null } } }),
      prisma.folder.deleteMany({ where: { id: { in: deletableFolders } } }),
    ]);
    await subUsage(ownerId, total);
    res.json({ ok: true, freedBytes: total.toString() });
  }),
);

export default router;
