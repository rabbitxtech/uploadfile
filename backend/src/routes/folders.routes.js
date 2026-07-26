import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../config/prisma.js';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../utils/async.js';
import { badRequest, conflict, forbidden, notFound } from '../utils/errors.js';
import { folderAccessLevel } from '../services/access.service.js';
import { stripIndexFieldsAll } from './files/_shared.js';
import {
  parseListQuery,
  fileOrderBy,
  folderOrderBy,
  filePageArgs,
  pageResult,
} from '../utils/listquery.js';

const router = Router();
router.use(requireAuth);

function joinPath(parentPath, name) {
  if (parentPath === '/' || !parentPath) return '/' + name;
  return parentPath + '/' + name;
}

/**
 * Refuse a folder name that would collide with an existing sibling.
 *
 * `Folder.path` is denormalised from folder NAMES, and the codebase treats
 * (ownerId, path) as a subtree identity in three separate places: the soft-delete
 * and rename here both match descendants with `path startsWith parent + '/'`,
 * `deletableFolderIds` decides what a bulk purge may cascade into, and
 * `grantCoversFolder` resolves folder shares. Nothing enforced that the identity
 * is actually unique, so two siblings could both sit at "/docs" — and then every
 * one of those path-prefix queries hit BOTH subtrees:
 *
 *   - deleting one "/docs" trashed the other's children and their files, while
 *     the sibling itself stayed live, so the files vanished from a folder the
 *     user never touched;
 *   - renaming one "/docs" to "/archive" rewrote the other's descendants too,
 *     leaving a child whose path ("/archive/sub") no longer matches its actual
 *     parent ("/docs") — a permanently inconsistent tree that then feeds the
 *     grant and cascade checks.
 *
 * WebDAV MKCOL already rejected duplicates (405); the REST route was the one way
 * in that did not. Uniqueness is enforced here rather than by a DB constraint
 * because trashed folders keep their path and must not block a live re-create.
 */
async function assertNoSiblingCollision(ownerId, path, excludeId = null) {
  const clash = await prisma.folder.findFirst({
    where: {
      ownerId,
      path,
      trashedAt: null,
      ...(excludeId ? { id: { not: excludeId } } : {}),
    },
    select: { id: true },
  });
  if (clash) throw conflict('A folder with that name already exists here');
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
// Task5 #20 — files are cursor-paginated (`?cursor=&take=&sort=&dir=`):
// the response carries `nextCursor` (null when done) and, on the first page
// only, `total` (file count) plus the folder list (folders are assumed few;
// only files explode into the thousands). Cursor pages return files only.
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const parentId = req.query.parentId || null;
    const normalizedParent = parentId === '' || parentId === null ? null : String(parentId);
    const page = parseListQuery(req.query);
    const firstPage = !page.cursor;

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
        const fileWhere = { ownerId: folder.ownerId, folderId: folder.id, trashedAt: null };
        const [folders, rows, total] = await Promise.all([
          firstPage
            ? prisma.folder.findMany({
                where: { ownerId: folder.ownerId, parentId: folder.id, trashedAt: null },
                orderBy: folderOrderBy(page.sort, page.dir),
              })
            : Promise.resolve([]),
          prisma.file.findMany({
            where: fileWhere,
            orderBy: fileOrderBy(page.sort, page.dir),
            include: { tags: true, owner: { select: { id: true, name: true, email: true } } },
            ...filePageArgs(page),
          }),
          firstPage ? prisma.file.count({ where: fileWhere }) : Promise.resolve(null),
        ]);
        const { files, nextCursor } = pageResult(rows, page.take);
        // Strip AFTER paging — pageResult derives the next cursor from files[].id.
        return res.json({
          current: folder,
          folders,
          files: stripIndexFieldsAll(files),
          nextCursor,
          total,
          shared: true,
        });
      }
    }

    const ownerId = effectiveOwnerId(req);
    const where = { ownerId, trashedAt: null, parentId: normalizedParent };
    const fileWhere = { ownerId, trashedAt: null, folderId: where.parentId };
    const [folders, rows, total, current] = await Promise.all([
      firstPage
        ? prisma.folder.findMany({ where, orderBy: folderOrderBy(page.sort, page.dir) })
        : Promise.resolve([]),
      prisma.file.findMany({
        where: fileWhere,
        orderBy: fileOrderBy(page.sort, page.dir),
        include: { tags: true, owner: { select: { id: true, name: true, email: true } } },
        ...filePageArgs(page),
      }),
      firstPage ? prisma.file.count({ where: fileWhere }) : Promise.resolve(null),
      where.parentId && firstPage
        ? prisma.folder.findFirst({ where: { id: where.parentId, ownerId } })
        : Promise.resolve(null),
    ]);
    const { files, nextCursor } = pageResult(rows, page.take);
    res.json({ current, folders, files: stripIndexFieldsAll(files), nextCursor, total });
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

    // A trashed parent is not a place anything can be created: the child would
    // be live inside a folder the listing hides, and a later restore of the
    // parent is the only thing that would ever surface it again.
    const parent = data.parentId
      ? await prisma.folder.findFirst({
          where: { id: data.parentId, ownerId: req.user.id, trashedAt: null },
        })
      : null;
    if (data.parentId && !parent) throw notFound('Parent folder');

    const path = joinPath(parent?.path ?? '/', data.name);
    await assertNoSiblingCollision(req.user.id, path);

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

    // Same rule as create, against the folder's own owner (an admin may be
    // renaming someone else's). Excluding `cur.id` keeps a no-op rename — and a
    // move that doesn't change the path — from colliding with itself.
    if (newPath !== cur.path) {
      await assertNoSiblingCollision(scopeOwner, newPath, cur.id);
    }

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
