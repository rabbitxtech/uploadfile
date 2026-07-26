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
export async function fileAccessLevel(user, file) {
  if (!file) return null;
  if (user.role === 'admin') return 'admin';
  if (file.ownerId === user.id) return 'owner';

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
        include: { folder: { select: { path: true, ownerId: true } } },
      });
      for (const g of grants) {
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
export async function folderAccessLevel(user, folder) {
  if (!folder) return null;
  if (user.role === 'admin') return 'admin';
  if (folder.ownerId === user.id) return 'owner';

  const groupIds = await userGroupIds(user.id);
  const grants = await prisma.folderGrant.findMany({
    where: granteeWhere(user.id, groupIds),
    include: { folder: { select: { path: true, ownerId: true } } },
  });
  let level = null;
  for (const g of grants) {
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
