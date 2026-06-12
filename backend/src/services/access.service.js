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
      select: { path: true },
    });
    if (folder) {
      const grants = await prisma.folderGrant.findMany({
        where: granteeWhere(user.id, groupIds),
        include: { folder: { select: { path: true } } },
      });
      for (const g of grants) {
        const gp = g.folder?.path;
        if (!gp) continue;
        const prefix = gp.endsWith('/') ? gp : gp + '/';
        if (folder.path === gp || folder.path.startsWith(prefix)) {
          if (g.permission === 'edit') level = 'edit';
          else if (!level) level = 'view';
        }
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
    include: { folder: { select: { path: true } } },
  });
  let level = null;
  for (const g of grants) {
    const gp = g.folder?.path;
    if (!gp) continue;
    const prefix = gp.endsWith('/') ? gp : gp + '/';
    if (folder.path === gp || folder.path.startsWith(prefix)) {
      if (g.permission === 'edit') level = 'edit';
      else if (!level) level = 'view';
    }
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
