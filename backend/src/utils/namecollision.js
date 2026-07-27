// One name, one resource, per (owner, folder).
//
// Three separate layers of this codebase resolve a name back to a row, and each
// of them assumes the mapping is unique:
//
//   - WebDAV `findFile()` / `findFolder()` (webdav.routes.js) resolve a path
//     segment with `findFirst`. With two live rows answering to one name, which
//     row a client reads, overwrites or deletes is decided by row order.
//   - The WebDAV PUT overwrite branch looks up `{ ownerId, folderId, name }` the
//     same way, so a second row with that name is the one it silently skips.
//   - The PROPFIND listing emits one <D:href> per row, so a duplicate shows up
//     twice in Finder/Explorer under one name.
//
// A folder additionally shadows a file outright: the PROPFIND handler tries
// `findFolder` first and answers <D:collection/>, and DELETE takes the folder
// branch — so the file at that path becomes unreadable and undeletable over
// WebDAV while staying live and billed against the owner's quota. That is the
// same "live, billed, reachable from neither view" state the trashed-parent
// gates, the restore-ancestor walk and `assertNoSiblingCollision` all exist to
// prevent; it was simply never enforced ACROSS the two kinds of row.
//
// Folder-vs-folder uniqueness is enforced separately by
// `assertNoSiblingCollision` in folders.routes.js, which works on the
// denormalised `Folder.path`. These helpers cover the two cases that had no
// check at all: file-vs-file, and file-vs-folder.
//
// Scoped to `trashedAt: null` for the same reason the folder rule is: a trashed
// row keeps its name and must not block re-creating one, since it is on its way
// out and is invisible to every listing.
import { prisma } from '../config/prisma.js';

/**
 * Is `name` already taken by a LIVE file in this folder (root when folderId is
 * null)? `excludeId` skips the row being renamed so a no-op rename can't collide
 * with itself.
 */
export async function findFileNameClash(ownerId, folderId, name, excludeId = null) {
  return prisma.file.findFirst({
    where: {
      ownerId,
      folderId: folderId ?? null,
      name,
      trashedAt: null,
      ...(excludeId ? { id: { not: excludeId } } : {}),
    },
    select: { id: true },
  });
}

/**
 * Is `name` already taken by a LIVE child FOLDER of this folder (root when
 * parentId is null)?
 *
 * Matched by (ownerId, parentId, name) rather than by `Folder.path`: path is
 * denormalised from names only and is not namespaced per owner, so a prefix or
 * equality match on it can cross into a stranger's identically-named tree — the
 * same hazard `grantCoversFolder` guards against. The parent link is the
 * authoritative statement of where a folder sits.
 */
export async function findFolderNameClash(ownerId, parentId, name, excludeId = null) {
  return prisma.folder.findFirst({
    where: {
      ownerId,
      parentId: parentId ?? null,
      name,
      trashedAt: null,
      ...(excludeId ? { id: { not: excludeId } } : {}),
    },
    select: { id: true },
  });
}
