import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../config/prisma.js';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../utils/async.js';
import { notFound } from '../utils/errors.js';
import { env } from '../config/env.js';
import { removeObject } from '../services/storage.service.js';
import { subUsage } from '../services/quota.service.js';

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
    res.json({ restored: results.reduce((n, r) => n + r.count, 0) });
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
    await prisma.file.delete({ where: { id: file.id } });
    await subUsage(file.ownerId, Number(totalBytes));
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
    }
    await prisma.$transaction([
      prisma.file.deleteMany({ where: { ownerId, trashedAt: { not: null } } }),
      prisma.folder.deleteMany({ where: { ownerId, trashedAt: { not: null } } }),
    ]);
    await subUsage(ownerId, Number(total));
    res.json({ ok: true, freedBytes: total.toString() });
  }),
);

export default router;
