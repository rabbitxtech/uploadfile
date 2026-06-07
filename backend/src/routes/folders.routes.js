import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../config/prisma.js';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../utils/async.js';
import { badRequest, forbidden, notFound } from '../utils/errors.js';
import { folderAccessLevel } from '../services/access.service.js';

const router = Router();
router.use(requireAuth);

function joinPath(parentPath, name) {
  if (parentPath === '/' || !parentPath) return '/' + name;
  return parentPath + '/' + name;
}

// Admin can view any user's tree by passing `?ownerId=`; non-admins always
// see their own.
function effectiveOwnerId(req) {
  if (req.user.role === 'admin' && req.query.ownerId) {
    return String(req.query.ownerId);
  }
  return req.user.id;
}

// List folders/files inside a folder (or root). `?parentId=` empty means root.
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const parentId = req.query.parentId || null;
    const normalizedParent = parentId === '' || parentId === null ? null : String(parentId);

    // Navigating into a specific folder: if the user doesn't own it (and isn't
    // an admin override), allow it when they have a folder grant on it or an
    // ancestor. This powers "Shared with me" folder browsing.
    if (normalizedParent) {
      const folder = await prisma.folder.findUnique({ where: { id: normalizedParent } });
      if (!folder || folder.trashedAt) throw notFound('Folder');
      const isOwner = folder.ownerId === req.user.id;
      const adminOverride = req.user.role === 'admin';
      if (!isOwner && !adminOverride) {
        const level = await folderAccessLevel(req.user, folder);
        if (!level) throw forbidden();
        // Granted: list this folder's contents by its real owner.
        const [folders, files] = await Promise.all([
          prisma.folder.findMany({
            where: { ownerId: folder.ownerId, parentId: folder.id, trashedAt: null },
            orderBy: { name: 'asc' },
          }),
          prisma.file.findMany({
            where: { ownerId: folder.ownerId, folderId: folder.id, trashedAt: null },
            orderBy: { name: 'asc' },
            include: { tags: true, owner: { select: { id: true, name: true, email: true } } },
          }),
        ]);
        return res.json({ current: folder, folders, files, shared: true });
      }
    }

    const ownerId = effectiveOwnerId(req);
    const where = { ownerId, trashedAt: null, parentId: normalizedParent };
    const [folders, files, current] = await Promise.all([
      prisma.folder.findMany({ where, orderBy: { name: 'asc' } }),
      prisma.file.findMany({
        where: { ownerId, trashedAt: null, folderId: where.parentId },
        orderBy: { name: 'asc' },
        include: { tags: true, owner: { select: { id: true, name: true, email: true } } },
      }),
      where.parentId
        ? prisma.folder.findFirst({ where: { id: where.parentId, ownerId } })
        : Promise.resolve(null),
    ]);
    res.json({ current, folders, files });
  }),
);

// Flat list of all owned folders for tree rendering on the client.
router.get(
  '/tree',
  asyncHandler(async (req, res) => {
    const ownerId = effectiveOwnerId(req);
    const folders = await prisma.folder.findMany({
      where: { ownerId, trashedAt: null },
      select: { id: true, name: true, parentId: true, path: true },
      orderBy: { name: 'asc' },
    });
    res.json({ folders });
  }),
);

// Breadcrumb: parents of a folder. Stops climbing at the boundary of what the
// user can see (their own folders, or — for shared folders — only down to the
// granted root so they don't see the owner's parent folder names).
router.get(
  '/:id/breadcrumb',
  asyncHandler(async (req, res) => {
    let cur = await prisma.folder.findUnique({ where: { id: req.params.id } });
    if (!cur) throw notFound('Folder');

    const ownerId = effectiveOwnerId(req);
    const owns = cur.ownerId === ownerId || req.user.role === 'admin';
    if (!owns) {
      const level = await folderAccessLevel(req.user, cur);
      if (!level) throw forbidden();
    }

    const trail = [];
    while (cur) {
      trail.unshift({ id: cur.id, name: cur.name });
      if (!cur.parentId) break;
      const parent = await prisma.folder.findUnique({ where: { id: cur.parentId } });
      // For shared folders, stop once we climb above what the user can access.
      if (parent && !owns) {
        const lvl = await folderAccessLevel(req.user, parent);
        if (!lvl) break;
      }
      cur = parent;
    }
    res.json({ trail });
  }),
);

router.post(
  '/',
  asyncHandler(async (req, res) => {
    const data = z
      .object({ name: z.string().min(1).max(255), parentId: z.string().nullable().optional() })
      .parse(req.body);

    const parent = data.parentId
      ? await prisma.folder.findFirst({ where: { id: data.parentId, ownerId: req.user.id } })
      : null;
    if (data.parentId && !parent) throw notFound('Parent folder');

    const path = joinPath(parent?.path ?? '/', data.name);

    const folder = await prisma.folder.create({
      data: {
        name: data.name,
        parentId: parent?.id ?? null,
        ownerId: req.user.id,
        path,
      },
    });
    res.status(201).json(folder);
  }),
);

router.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const data = z
      .object({ name: z.string().min(1).max(255).optional(), parentId: z.string().nullable().optional() })
      .parse(req.body);
    // Admin can edit any folder; users only their own.
    const cur = await prisma.folder.findFirst({
      where: { id: req.params.id, ...(req.user.role === 'admin' ? {} : { ownerId: req.user.id }) },
    });
    if (!cur) throw notFound('Folder');
    const scopeOwner = cur.ownerId; // descendants belong to the folder's owner

    let parentPath = '/';
    if (data.parentId !== undefined) {
      if (data.parentId === cur.id) throw badRequest('Cannot move folder into itself');
      const parent = data.parentId
        ? await prisma.folder.findFirst({ where: { id: data.parentId, ownerId: scopeOwner } })
        : null;
      if (data.parentId && !parent) throw notFound('Parent folder');
      // Prevent moving into a descendant
      if (parent && parent.path.startsWith(cur.path + '/')) {
        throw badRequest('Cannot move into a descendant');
      }
      parentPath = parent?.path ?? '/';
    } else {
      const p = cur.parentId
        ? await prisma.folder.findUnique({ where: { id: cur.parentId } })
        : null;
      parentPath = p?.path ?? '/';
    }

    const newName = data.name ?? cur.name;
    const newPath = joinPath(parentPath, newName);

    const updated = await prisma.$transaction(async (tx) => {
      // Update self
      const u = await tx.folder.update({
        where: { id: cur.id },
        data: {
          name: newName,
          parentId: data.parentId !== undefined ? data.parentId ?? null : cur.parentId,
          path: newPath,
        },
      });
      // Update all descendants' path prefix
      const oldPrefix = cur.path + '/';
      const descendants = await tx.folder.findMany({
        where: { ownerId: scopeOwner, path: { startsWith: oldPrefix } },
      });
      for (const d of descendants) {
        await tx.folder.update({
          where: { id: d.id },
          data: { path: newPath + d.path.slice(cur.path.length) },
        });
      }
      return u;
    });
    res.json(updated);
  }),
);

// Soft-delete (move to trash) — also marks files inside as trashed.
router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    // Admin can delete any folder; users only their own.
    const cur = await prisma.folder.findFirst({
      where: { id: req.params.id, ...(req.user.role === 'admin' ? {} : { ownerId: req.user.id }) },
    });
    if (!cur) throw notFound('Folder');
    const scopeOwner = cur.ownerId;
    const now = new Date();
    const prefix = cur.path === '/' ? '/' : cur.path + '/';

    await prisma.$transaction([
      prisma.folder.updateMany({
        where: {
          ownerId: scopeOwner,
          OR: [{ id: cur.id }, { path: { startsWith: prefix } }],
        },
        data: { trashedAt: now },
      }),
      prisma.file.updateMany({
        where: {
          ownerId: scopeOwner,
          folder: { OR: [{ id: cur.id }, { path: { startsWith: prefix } }] },
        },
        data: { trashedAt: now },
      }),
    ]);
    res.json({ trashedAt: now });
  }),
);

export default router;
