import { prisma } from '../config/prisma.js';

// Group ids the user belongs to (Task5 #14) — grants can target a group
// instead of a single user, so every access check ORs these in.
async function userGroupIds(userId) {
  const rows = await prisma.groupMember.findMany({
    where: { userId },
    select: { groupId: true },
  });
  return rows.map((r) => r.groupId);
}

// where-clause matching grants aimed at this user directly OR at any of their groups.
function granteeWhere(userId, groupIds) {
  const or = [{ userId }];
  if (groupIds.length) or.push({ groupId: { in: groupIds } });
  return { OR: or };
}

/**
 * Does `folder` sit at, or under, the folder a grant was made on?
 *
 * Folder.path is a denormalised string like "/docs/2025" built from folder
 * NAMES only — it is not namespaced per owner, so two users can each own a
 * folder at "/docs". Matching on the path alone therefore lets a grant on one
 * owner's tree resolve against an identically-named folder belonging to someone
 * else. The grant's own folder carries the authoritative owner, so require the
 * target to belong to that same owner as well as sit under the path.
 */
function grantCoversFolder(grantFolder, folder) {
  if (!grantFolder?.path || !folder?.path) return false;
  // Both owners must actually be loaded. An absent ownerId is a caller bug (a
  // `select` that dropped the column), and comparing against undefined would
  // silently make every grant stop matching — a folder share that just quietly
  // stops working, with no error to trace it by. Fail loudly instead.
  if (!grantFolder.ownerId || !folder.ownerId) {
    throw new Error('grantCoversFolder: ownerId missing — the caller must select it');
  }
  if (grantFolder.ownerId !== folder.ownerId) return false;
  const prefix = grantFolder.path.endsWith('/') ? grantFolder.path : grantFolder.path + '/';
  return folder.path === grantFolder.path || folder.path.startsWith(prefix);
}

// Resolve a user's access level to a file.
// Returns one of: 'owner' | 'admin' | 'edit' | 'view' | null
//
// Access can come from:
//  - being the owner, or an admin (full access)
//  - a direct FileGrant on the file (to the user or one of their groups)
//  - a FolderGrant on the file's folder or any ancestor folder (path prefix)
//
// TRASHING REVOKES GRANT-DERIVED ACCESS. Trashing is the user's "un-share it"
// action, and the rest of the codebase already treats it that way: a public
// share link 404s once its target is trashed (assertShareTargetLive), and
// GET /api/grants/shared-with-me filters trashed rows out of the listing, so
// the file disappears from the grantee's "Shared with me" the moment the owner
// deletes it. Nothing enforced it on the file routes themselves, so the access
// simply outlived the listing: a grantee who had kept the id (it travels in
// links and pasted URLs) could still call GET /files/:id — which returns the
// row INCLUDING ocrText, a file's entire extracted text — and /download,
// /preview and /url, the last handing back a presigned MinIO URL for the real
// bytes. The owner sees the file sitting in their trash and has every reason to
// believe deleting it stopped the sharing.
//
// Owner and admin deliberately keep access: the Trash page reads the row to
// list it, and restoring then downloading is the ordinary flow. So the gate
// belongs here, below the owner/admin returns and above the grant lookups —
// the same shape as the write-side trashed gates, which likewise only ever
// restrict what a GRANT reaches.
export async function fileAccessLevel(user, file) {
  if (!file) return null;
  if (user.role === 'admin') return 'admin';
  if (file.ownerId === user.id) return 'owner';
  if (file.trashedAt) return null;

  let level = null;
  const groupIds = await userGroupIds(user.id);

  const fgs = await prisma.fileGrant.findMany({
    where: { fileId: file.id, ...granteeWhere(user.id, groupIds) },
  });
  for (const g of fgs) {
    if (g.permission === 'edit') level = 'edit';
    else if (!level) level = 'view';
  }

  if (file.folderId) {
    const folder = await prisma.folder.findUnique({
      where: { id: file.folderId },
      select: { path: true, ownerId: true },
    });
    if (folder) {
      const grants = await prisma.folderGrant.findMany({
        where: granteeWhere(user.id, groupIds),
        include: { folder: { select: { path: true, ownerId: true, trashedAt: true } } },
      });
      for (const g of grants) {
        // A grant whose own folder has been trashed reaches nothing, exactly as
        // in folderAccessLevel — trashing the shared folder is how an owner
        // un-shares its contents.
        if (g.folder?.trashedAt) continue;
        if (!grantCoversFolder(g.folder, folder)) continue;
        if (g.permission === 'edit') level = 'edit';
        else if (!level) level = 'view';
      }
    }
  }
  return level;
}

export function canEdit(level) {
  return level === 'owner' || level === 'admin' || level === 'edit';
}

// Resolve a user's access level to a folder (direct grant or grant on an
// ancestor folder, to the user or one of their groups).
// Returns 'owner' | 'admin' | 'edit' | 'view' | null.
//
// Trashing revokes grant-derived access here for the same reason it does on a
// file, and the inconsistency was visible in the same place: GET
// /api/grants/shared-with-me filters trashed folders out of "Shared with me",
// while the folder routes kept resolving the grant. GET /folders/:id/breadcrumb
// went on answering 200 with the folder's NAME for a folder the owner had
// deleted, and a grant on a trashed ancestor still reached down the tree.
//
// The grant's OWN folder is checked too, not just the target: a grant made on
// "/projects" must stop resolving once "/projects" is trashed, or trashing the
// shared folder itself would revoke nothing. Trashing a folder stamps its whole
// subtree, so both ends are normally trashed together — but restore un-trashes
// only the ids it is handed, so the two can legitimately diverge.
export async function folderAccessLevel(user, folder) {
  if (!folder) return null;
  if (user.role === 'admin') return 'admin';
  if (folder.ownerId === user.id) return 'owner';
  if (folder.trashedAt) return null;

  const groupIds = await userGroupIds(user.id);
  const grants = await prisma.folderGrant.findMany({
    where: granteeWhere(user.id, groupIds),
    include: { folder: { select: { path: true, ownerId: true, trashedAt: true } } },
  });
  let level = null;
  for (const g of grants) {
    if (g.folder?.trashedAt) continue; // the shared folder itself is deleted
    if (!grantCoversFolder(g.folder, folder)) continue;
    if (g.permission === 'edit') level = 'edit';
    else if (!level) level = 'view';
  }
  return level;
}

// Fetch a file and assert the user can at least read it. Returns { file, level }
// or throws nothing — callers check `file` for null to 404.
export async function getReadableFile(user, id, include) {
  const file = await prisma.file.findUnique({ where: { id }, include });
  if (!file) return { file: null, level: null };
  const level = await fileAccessLevel(user, file);
  if (!level) return { file: null, level: null };
  return { file, level };
}
