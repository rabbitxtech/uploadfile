// Internal sharing: grant another registered user access to a file or folder.
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../config/prisma.js';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../utils/async.js';
import { badRequest, forbidden, notFound } from '../utils/errors.js';
import { notify } from '../services/notify.service.js';

const router = Router();
router.use(requireAuth);

const publicUser = (u) => ({ id: u.id, name: u.name, email: u.email });

// Files + folders shared with the current user.
router.get(
  '/shared-with-me',
  asyncHandler(async (req, res) => {
    const [fileGrants, folderGrants] = await Promise.all([
      prisma.fileGrant.findMany({
        where: { userId: req.user.id },
        include: {
          file: {
            include: { owner: { select: { id: true, name: true, email: true } }, tags: true },
          },
        },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.folderGrant.findMany({
        where: { userId: req.user.id },
        include: {
          folder: { include: { owner: { select: { id: true, name: true, email: true } } } },
        },
        orderBy: { createdAt: 'desc' },
      }),
    ]);
    res.json({
      files: fileGrants
        .filter((g) => g.file && !g.file.trashedAt)
        .map((g) => ({ ...g.file, permission: g.permission, grantId: g.id })),
      folders: folderGrants
        .filter((g) => g.folder && !g.folder.trashedAt)
        .map((g) => ({ ...g.folder, permission: g.permission, grantId: g.id })),
    });
  }),
);

// List grants on a resource (owner or admin).
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const fileId = req.query.fileId ? String(req.query.fileId) : null;
    const folderId = req.query.folderId ? String(req.query.folderId) : null;
    if (!fileId && !folderId) throw badRequest('fileId or folderId required');

    if (fileId) {
      const file = await prisma.file.findUnique({ where: { id: fileId } });
      if (!file) throw notFound('File');
      if (file.ownerId !== req.user.id && req.user.role !== 'admin') throw forbidden();
      const grants = await prisma.fileGrant.findMany({
        where: { fileId },
        include: { user: { select: { id: true, name: true, email: true } } },
        orderBy: { createdAt: 'asc' },
      });
      return res.json({
        grants: grants.map((g) => ({ id: g.id, permission: g.permission, user: publicUser(g.user) })),
      });
    }

    const folder = await prisma.folder.findUnique({ where: { id: folderId } });
    if (!folder) throw notFound('Folder');
    if (folder.ownerId !== req.user.id && req.user.role !== 'admin') throw forbidden();
    const grants = await prisma.folderGrant.findMany({
      where: { folderId },
      include: { user: { select: { id: true, name: true, email: true } } },
      orderBy: { createdAt: 'asc' },
    });
    res.json({
      grants: grants.map((g) => ({ id: g.id, permission: g.permission, user: publicUser(g.user) })),
    });
  }),
);

// Create / update a grant. Body: { fileId|folderId, identifier, permission }
router.post(
  '/',
  asyncHandler(async (req, res) => {
    const data = z
      .object({
        fileId: z.string().optional(),
        folderId: z.string().optional(),
        identifier: z.string().trim().min(1), // grantee username or email
        permission: z.enum(['view', 'edit']).default('view'),
      })
      .refine((d) => !!d.fileId || !!d.folderId, { message: 'fileId or folderId required' })
      .parse(req.body);

    const grantee = await prisma.user.findUnique({ where: { email: data.identifier } });
    if (!grantee) throw notFound('User to share with');
    if (grantee.id === req.user.id) throw badRequest('Cannot share with yourself');

    if (data.fileId) {
      const file = await prisma.file.findUnique({ where: { id: data.fileId } });
      if (!file) throw notFound('File');
      if (file.ownerId !== req.user.id && req.user.role !== 'admin') throw forbidden();
      if (file.ownerId === grantee.id) throw badRequest('User already owns this file');

      const grant = await prisma.fileGrant.upsert({
        where: { fileId_userId: { fileId: file.id, userId: grantee.id } },
        update: { permission: data.permission },
        create: { fileId: file.id, userId: grantee.id, permission: data.permission },
      });
      notify(grantee.id, {
        type: 'shared_with_you',
        title: `${req.user.name || req.user.email} shared a file with you`,
        body: `"${file.name}" (${data.permission} access)`,
        link: '/shared-with-me',
      });
      return res.status(201).json({ id: grant.id, permission: grant.permission });
    }

    const folder = await prisma.folder.findUnique({ where: { id: data.folderId } });
    if (!folder) throw notFound('Folder');
    if (folder.ownerId !== req.user.id && req.user.role !== 'admin') throw forbidden();
    if (folder.ownerId === grantee.id) throw badRequest('User already owns this folder');

    const grant = await prisma.folderGrant.upsert({
      where: { folderId_userId: { folderId: folder.id, userId: grantee.id } },
      update: { permission: data.permission },
      create: { folderId: folder.id, userId: grantee.id, permission: data.permission },
    });
    notify(grantee.id, {
      type: 'shared_with_you',
      title: `${req.user.name || req.user.email} shared a folder with you`,
      body: `"${folder.name}" (${data.permission} access)`,
      link: '/shared-with-me',
    });
    res.status(201).json({ id: grant.id, permission: grant.permission });
  }),
);

// Revoke a grant by type + id (owner or admin).
router.delete(
  '/file/:id',
  asyncHandler(async (req, res) => {
    const grant = await prisma.fileGrant.findUnique({
      where: { id: req.params.id },
      include: { file: true },
    });
    if (!grant) throw notFound('Grant');
    if (grant.file.ownerId !== req.user.id && req.user.role !== 'admin') throw forbidden();
    await prisma.fileGrant.delete({ where: { id: grant.id } });
    res.json({ ok: true });
  }),
);

router.delete(
  '/folder/:id',
  asyncHandler(async (req, res) => {
    const grant = await prisma.folderGrant.findUnique({
      where: { id: req.params.id },
      include: { folder: true },
    });
    if (!grant) throw notFound('Grant');
    if (grant.folder.ownerId !== req.user.id && req.user.role !== 'admin') throw forbidden();
    await prisma.folderGrant.delete({ where: { id: grant.id } });
    res.json({ ok: true });
  }),
);

export default router;
