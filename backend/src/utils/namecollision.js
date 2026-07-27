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
import { badRequest } from './errors.js';

/**
 * A name is ONE path segment.
 *
 * `Folder.path` is built by joining names with "/", and both the name and the
 * path are read back as structure — so a name that itself contains "/" is not a
 * name at all, it is a forged path. Nothing validated that, and all three layers
 * that consume the value broke in a different way:
 *
 *   - A folder created as `name: "work/reports/archive"` gets `path:
 *     "/work/reports/archive"` with `parentId: null`. It is a ROOT folder
 *     claiming a position deep inside another tree, so the real
 *     `/work/reports/archive` can never be created (409, pointing at a folder
 *     that is not there), and deleting the entirely unrelated `/work` sweeps it
 *     into the trash — the soft-delete cascades on `path startsWith "/work/"`.
 *     Restore then cannot bring it back, because the restore walk climbs
 *     `parentId` and this row's parent is null. The same prefix reasoning drives
 *     `deletableFolderIds` and `grantCoversFolder`, so a forged path reaches
 *     into a purge decision and a share resolution too.
 *   - A file named "sub/evil.txt" makes PROPFIND emit
 *     `<D:href>/webdav/box/sub/evil.txt</D:href>` inside a one-level listing,
 *     and WebDAV's `findFile()` splits a request path on the LAST "/", so it can
 *     never resolve that row again: live, billed, and unreadable/undeletable
 *     over WebDAV — the exact state the file-vs-folder rule below exists to
 *     prevent.
 *   - `archive.append(stream, { name: f.name })` writes the name straight into
 *     the ZIP central directory, so "../../../tmp/x" ships a Zip Slip entry to
 *     whoever opens the download.
 *
 * `from-url` already did this (`filenameFromUrl` pops the last path segment),
 * which is what a correct name looks like; every other entry point took the
 * caller's string verbatim.
 *
 * Backslash counts as a separator too: WebDAV clients on Windows and the ZIP
 * spec both treat it as one, so allowing it would move the same forgery one
 * encoding away.
 *
 * Two kinds of caller need two different answers, which is what `mode` selects:
 *
 *   - `'reject'` (default) for a name the USER typed — a folder create or
 *     rename, a file rename. Someone who types "work/reports" meant a path;
 *     quietly storing a folder called "reports" would carry out a different
 *     instruction than the one they gave, and they are right there to retype it.
 *     400.
 *   - `'strip'` for a name that ARRIVES attached to content — a multipart
 *     upload's filename, an anonymous drop-box submission. The sender picked
 *     that string incidentally (browsers and CLI clients routinely put a path
 *     in it) and the bytes are already here, so reducing it to its last segment
 *     is both the useful answer and the one `filenameFromUrl` has always given.
 *     Refusing would fail a legitimate upload over a detail the user never sees.
 *
 * "." and ".." are refused in BOTH modes: they are traversal rather than a name,
 * and there is no last segment to fall back to.
 */
export function sanitizeEntryName(raw, { label = 'name', mode = 'reject' } = {}) {
  const value = String(raw ?? '');
  if (mode === 'reject' && /[/\\]/.test(value)) {
    throw badRequest(`Invalid ${label}: a name cannot contain a path separator`);
  }
  const segments = value.split(/[/\\]/);
  const name = segments[segments.length - 1].trim();
  if (!name || name === '.' || name === '..') throw badRequest(`Invalid ${label}`);
  // NUL and the C0 range terminate strings in filesystems, HTTP headers and the
  // ZIP directory alike, so a name carrying one means something different
  // downstream than it does here.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) throw badRequest(`Invalid ${label}`);
  return name;
}

/**
 * The same one-segment rule, applied when READING a stored name back out into a
 * format that reads it as a path — currently the ZIP entry name in the bulk
 * download and the public folder-share download.
 *
 * The write paths above now refuse a forged name, but rows created before that
 * still carry one, and a stored "../../../tmp/x" becomes a Zip Slip entry the
 * moment it is archived.
 *
 * `'strip'`, not `'reject'`: there is no user here to retype anything, and the
 * point is to hand back the harmless part of the name. "../../../tmp/x.txt"
 * belongs in the archive as "x.txt" — dropping it to a placeholder would lose
 * the one piece of information the recipient can use. It also never throws: a
 * download of 200 files must not 500 because one legacy row is unsalvageable
 * (a name that is nothing but separators), so that case falls back to a
 * placeholder, which at least shows up in the archive rather than vanishing.
 */
export function zipEntryName(raw, fallback = 'file') {
  try {
    return sanitizeEntryName(raw, { mode: 'strip' });
  } catch {
    return fallback;
  }
}

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
