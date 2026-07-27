// Internal sharing: grant another registered user access to a file or folder.
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../config/prisma.js';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../utils/async.js';
import { badRequest, forbidden, notFound } from '../utils/errors.js';
import { notify } from '../services/notify.service.js';
import { stripIndexFields } from './files/_shared.js';
import { findUserByCredential } from '../utils/credential.js';

const router = Router();
router.use(requireAuth);

const publicUser = (u) => ({ id: u.id, name: u.name, email: u.email });

// Files + folders shared with the current user — directly or via one of their
// groups (Task5 #14). Group-sourced entries carry `viaGroup` so the UI can show
// where the access comes from (and not offer a revoke the user can't do).
router.get(
  '/shared-with-me',
  asyncHandler(async (req, res) => {
    const memberships = await prisma.groupMember.findMany({
      where: { userId: req.user.id },
      select: { groupId: true },
    });
    const groupIds = memberships.map((m) => m.groupId);
    const granteeOr = [{ userId: req.user.id }, ...(groupIds.length ? [{ groupId: { in: groupIds } }] : [])];

    const [fileGrants, folderGrants] = await Promise.all([
      prisma.fileGrant.findMany({
        where: { OR: granteeOr },
        include: {
          file: {
            include: { owner: { select: { id: true, name: true, email: true } }, tags: true },
          },
          group: { select: { name: true } },
        },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.folderGrant.findMany({
        where: { OR: granteeOr },
        include: {
          folder: { include: { owner: { select: { id: true, name: true, email: true } } } },
          group: { select: { name: true } },
        },
        orderBy: { createdAt: 'desc' },
      }),
    ]);
    res.json({
      files: fileGrants
        .filter((g) => g.file && !g.file.trashedAt && g.file.ownerId !== req.user.id)
        .map((g) => ({
          ...stripIndexFields(g.file),
          permission: g.permission,
          grantId: g.id,
          viaGroup: g.group?.name || null,
        })),
      folders: folderGrants
        .filter((g) => g.folder && !g.folder.trashedAt && g.folder.ownerId !== req.user.id)
        .map((g) => ({ ...g.folder, permission: g.permission, grantId: g.id, viaGroup: g.group?.name || null })),
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

    const mapGrant = (g) => ({
      id: g.id,
      permission: g.permission,
      user: g.user ? publicUser(g.user) : null,
      group: g.group ? { id: g.group.id, name: g.group.name } : null,
    });

    if (fileId) {
      const file = await prisma.file.findUnique({ where: { id: fileId } });
      if (!file) throw notFound('File');
      if (file.ownerId !== req.user.id && req.user.role !== 'admin') throw forbidden();
      const grants = await prisma.fileGrant.findMany({
        where: { fileId },
        include: {
          user: { select: { id: true, name: true, email: true } },
          group: { select: { id: true, name: true } },
        },
        orderBy: { createdAt: 'asc' },
      });
      return res.json({ grants: grants.map(mapGrant) });
    }

    const folder = await prisma.folder.findUnique({ where: { id: folderId } });
    if (!folder) throw notFound('Folder');
    if (folder.ownerId !== req.user.id && req.user.role !== 'admin') throw forbidden();
    const grants = await prisma.folderGrant.findMany({
      where: { folderId },
      include: {
        user: { select: { id: true, name: true, email: true } },
        group: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
    res.json({ grants: grants.map(mapGrant) });
  }),
);

// Create / update a grant. Body: { fileId|folderId, identifier|groupId, permission }
// — identifier targets a user (username/email), groupId targets a whole group
// (Task5 #14): every member gets access and a notification.
router.post(
  '/',
  asyncHandler(async (req, res) => {
    const data = z
      .object({
        fileId: z.string().optional(),
        folderId: z.string().optional(),
        identifier: z.string().trim().min(1).optional(), // grantee username or email
        groupId: z.string().optional(), // grantee group
        permission: z.enum(['view', 'edit']).default('view'),
      })
      .refine((d) => !!d.fileId || !!d.folderId, { message: 'fileId or folderId required' })
      .refine((d) => !!d.identifier !== !!d.groupId, { message: 'identifier or groupId required (not both)' })
      .parse(req.body);

    // Resolve the grantee (user or group) up front.
    let grantee = null;
    let group = null;
    if (data.identifier) {
      // Same credential rule as login: self-registered accounts are stored
      // lowercased, so sharing to the address exactly as its owner writes it
      // ("Bob@Example.com") used to 404 with no hint that only the lowercase
      // spelling resolves.
      grantee = await findUserByCredential(data.identifier);
      if (!grantee) throw notFound('User to share with');
      if (grantee.id === req.user.id) throw badRequest('Cannot share with yourself');
    } else {
      group = await prisma.group.findUnique({
        where: { id: data.groupId },
        include: { members: { select: { userId: true } } },
      });
      if (!group) throw notFound('Group to share with');
    }

    const notifyGrantees = (kind, name) => {
      const payload = (uid) =>
        notify(uid, {
          type: 'shared_with_you',
          title: group
            ? `${req.user.name || req.user.email} shared a ${kind} with the group "${group.name}"`
            : `${req.user.name || req.user.email} shared a ${kind} with you`,
          body: `"${name}" (${data.permission} access)`,
          link: '/shared-with-me',
        });
      if (grantee) payload(grantee.id);
      else for (const m of group.members) if (m.userId !== req.user.id) payload(m.userId);
    };

    if (data.fileId) {
      // A trashed file is not a share target. Trashing is this codebase's
      // "un-share it" action and every other surface already says so: a public
      // link 404s once its target is trashed (assertShareTargetLive),
      // fileAccessLevel returns null for a grantee on a trashed file, and
      // GET /shared-with-me filters trashed rows out of the listing. This route
      // was the one place that still WROTE a grant against one.
      //
      // The grant is not inert while the file sits in the trash — it is a row
      // that springs to life the moment the file is restored. Restoring is an
      // ordinary act of housekeeping ("I deleted that by mistake"), and the owner
      // has no reason to expect it also hands out access they never granted while
      // the file was visible. An admin can reach any file here, so this is also
      // the path by which a third party gains standing access to a file its owner
      // believes they have deleted.
      const file = await prisma.file.findUnique({ where: { id: data.fileId } });
      if (!file || file.trashedAt) throw notFound('File');
      if (file.ownerId !== req.user.id && req.user.role !== 'admin') throw forbidden();
      if (grantee && file.ownerId === grantee.id) throw badRequest('User already owns this file');

      const grant = grantee
        ? await prisma.fileGrant.upsert({
            where: { fileId_userId: { fileId: file.id, userId: grantee.id } },
            update: { permission: data.permission },
            create: { fileId: file.id, userId: grantee.id, permission: data.permission },
          })
        : await prisma.fileGrant.upsert({
            where: { fileId_groupId: { fileId: file.id, groupId: group.id } },
            update: { permission: data.permission },
            create: { fileId: file.id, groupId: group.id, permission: data.permission },
          });
      notifyGrantees('file', file.name);
      return res.status(201).json({ id: grant.id, permission: grant.permission });
    }

    // Same rule on the folder side, and it reaches further: folderAccessLevel
    // resolves a grant down the whole subtree by path prefix, so a grant written
    // against a trashed folder becomes access to everything under it the moment
    // the folder is restored.
    const folder = await prisma.folder.findUnique({ where: { id: data.folderId } });
    if (!folder || folder.trashedAt) throw notFound('Folder');
    if (folder.ownerId !== req.user.id && req.user.role !== 'admin') throw forbidden();
    if (grantee && folder.ownerId === grantee.id) throw badRequest('User already owns this folder');

    const grant = grantee
      ? await prisma.folderGrant.upsert({
          where: { folderId_userId: { folderId: folder.id, userId: grantee.id } },
          update: { permission: data.permission },
          create: { folderId: folder.id, userId: grantee.id, permission: data.permission },
        })
      : await prisma.folderGrant.upsert({
          where: { folderId_groupId: { folderId: folder.id, groupId: group.id } },
          update: { permission: data.permission },
          create: { folderId: folder.id, groupId: group.id, permission: data.permission },
        });
    notifyGrantees('folder', folder.name);
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
