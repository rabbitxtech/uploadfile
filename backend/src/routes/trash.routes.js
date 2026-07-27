import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../config/prisma.js';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../utils/async.js';
import { notFound } from '../utils/errors.js';
import { env } from '../config/env.js';
import { removeObject } from '../services/storage.service.js';
import { removeHls } from '../services/hls.service.js';
import { subUsage } from '../services/quota.service.js';
import { deletableFolderIds } from '../utils/foldercascade.js';
import { findFileNameClash, findFolderNameClash } from '../utils/namecollision.js';
import { emitFileChange } from '../realtime/bus.js';

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

    // Resolve the targets first — the ancestor walk below needs each item's own
    // owner and parent, and `ownerScope(req)` is `{}` for an admin, so the rows
    // being restored are the only thing that says whose tree to climb.
    const [targetFiles, targetFolders] = await Promise.all([
      data.fileIds?.length
        ? prisma.file.findMany({
            where: { id: { in: data.fileIds }, ...ownerScope(req) },
            select: { id: true, ownerId: true, folderId: true, name: true },
          })
        : Promise.resolve([]),
      data.folderIds?.length
        ? prisma.folder.findMany({
            where: { id: { in: data.folderIds }, ...ownerScope(req) },
            select: { id: true, ownerId: true, parentId: true, name: true, path: true },
          })
        : Promise.resolve([]),
    ]);

    // Un-trashing only the row the user clicked leaves it live inside an
    // ancestor that is still trashed — and neither listing shows it then:
    // GET /api/folders filters `trashedAt: null` and so hides the ancestor
    // (there is no path to browse through it), while GET /api/trash lists
    // `trashedAt: { not: null }` and so no longer lists the item itself. The row
    // stays live and billed against the owner's quota with no way to reach it
    // from the UI, and no error anywhere. Restoring a file out of a trashed
    // folder is the ordinary way to use the Trash page — it lists trashed files
    // and trashed folders in two separate tables — so this was one click away.
    //
    // The walk goes UP only. Restoring downward would undo the user's choice:
    // they picked one item out of a trashed folder, and the folder's other
    // contents must stay in the trash. Ancestors are the minimum needed to make
    // the restored row reachable.
    //
    // Climbing by parentId (not by the `path` prefix) is deliberate:
    // `Folder.path` is names-only and not namespaced per owner, so a prefix
    // match can cross into a stranger's identically-named tree. Each chain is
    // additionally pinned to its own item's ownerId for the same reason.
    //
    // The walk is resolved PER ITEM rather than into one shared set, because an
    // item whose chain cannot be restored (see the collision rule below) must be
    // held back with it — restoring the row while its ancestor stays trashed is
    // precisely the unreachable state this walk exists to prevent.
    const chainCache = new Map();
    async function trashedAncestors(ownerId, startParentId) {
      const key = `${ownerId}::${startParentId ?? ''}`;
      if (chainCache.has(key)) return chainCache.get(key);
      const chain = [];
      const seen = new Set();
      let cursor = startParentId;
      // Bounded by the folder depth; `seen` also stops a cycle from a corrupted
      // parent chain turning this into an infinite loop.
      while (cursor && !seen.has(cursor)) {
        seen.add(cursor);
        const parent = await prisma.folder.findFirst({
          where: { id: cursor, ownerId },
          select: { id: true, parentId: true, trashedAt: true, path: true, name: true },
        });
        if (!parent) break;
        if (parent.trashedAt) chain.push(parent);
        cursor = parent.parentId;
      }
      chainCache.set(key, chain);
      return chain;
    }

    // One name, one live resource — the rule every OTHER name-choosing path in
    // this codebase enforces, and the one this route had no check for at all.
    //
    // Those checks are scoped to `trashedAt: null` on purpose: a trashed row
    // keeps its name and must not block re-creating one, since it is on its way
    // out and invisible to every listing. That carve-out is exactly what makes
    // the collision reachable here, through ordinary housekeeping rather than an
    // attack — delete "docs", create a new "docs", restore the old one from the
    // trash, and two live folders now sit at "/docs".
    //
    // That pair is read as a SUBTREE IDENTITY by three separate layers: the
    // folder soft-delete and the rename both select descendants with
    // `path startsWith parent + '/'` (so deleting one "/docs" trashes the
    // OTHER's children and their files, and renaming one rewrites the other's
    // descendants into a tree whose children no longer match their parent),
    // `deletableFolderIds` decides what a bulk purge may cascade into, and
    // `grantCoversFolder` resolves folder shares.
    //
    // File-vs-folder is worse than a duplicate: WebDAV's PROPFIND tries
    // findFolder before findFile and answers <D:collection/>, and DELETE takes
    // the folder branch, so the file is live, billed, and both unreadable and
    // undeletable there.
    //
    // File-vs-FILE is deliberately allowed: two uploads of "report.pdf" is
    // long-standing product behaviour (the Uploader offers a replace) and both
    // rows stay visible in the REST listing, so restore must not invent a
    // stricter rule than upload has.
    //
    // Blocked items are SKIPPED and reported rather than failing the request —
    // "Restore all" over a full trash must not be lost to one clash, and the
    // route already returns a `restored` count that can be lower than what was
    // asked for.
    let skipped = 0;
    const ancestorIds = new Set();

    // Would un-trashing this folder land it on a path a live folder already
    // holds? Used for the folders the user named AND for every ancestor the walk
    // would resurrect — an ancestor is un-trashed onto a path that may now be
    // occupied just as readily as the item itself.
    async function folderPathTaken(ownerId, folder) {
      const clash = await prisma.folder.findFirst({
        where: { ownerId, path: folder.path, trashedAt: null, id: { not: folder.id } },
        select: { id: true },
      });
      return !!clash;
    }

    async function chainIsRestorable(ownerId, chain) {
      for (const a of chain) {
        if (await folderPathTaken(ownerId, a)) return false;
      }
      return true;
    }

    const restoreFiles = [];
    for (const f of targetFiles) {
      const chain = await trashedAncestors(f.ownerId, f.folderId);
      // A file may share a name with another FILE, but not with a live FOLDER.
      const folderClash = await findFolderNameClash(f.ownerId, f.folderId ?? null, f.name);
      if (folderClash || !(await chainIsRestorable(f.ownerId, chain))) {
        skipped += 1;
        continue;
      }
      restoreFiles.push(f);
      for (const a of chain) ancestorIds.add(a.id);
    }

    const restoreFolders = [];
    for (const f of targetFolders) {
      const fileClash = await findFileNameClash(f.ownerId, f.parentId ?? null, f.name);
      const chain = await trashedAncestors(f.ownerId, f.parentId);
      if (
        (await folderPathTaken(f.ownerId, f)) ||
        fileClash ||
        !(await chainIsRestorable(f.ownerId, chain))
      ) {
        skipped += 1;
        continue;
      }
      restoreFolders.push(f);
      for (const a of chain) ancestorIds.add(a.id);
    }

    const ops = [];
    if (restoreFiles.length) {
      ops.push(
        prisma.file.updateMany({
          where: { id: { in: restoreFiles.map((f) => f.id) } },
          data: { trashedAt: null },
        }),
      );
    }
    if (restoreFolders.length) {
      ops.push(
        prisma.folder.updateMany({
          where: { id: { in: restoreFolders.map((f) => f.id) } },
          data: { trashedAt: null },
        }),
      );
    }
    // Ancestors are restored alongside, but deliberately NOT counted in
    // `restored` — that number is what the client reports back to the user, and
    // it should reflect what they asked for, not the plumbing it took.
    if (ancestorIds.size) {
      ops.push(
        prisma.folder.updateMany({
          where: { id: { in: [...ancestorIds] } },
          data: { trashedAt: null },
        }),
      );
    }
    const results = await prisma.$transaction(ops);
    // Drop the ancestor op's count before summing, for the reason above.
    if (ancestorIds.size) results.pop();
    const restored = results.reduce((n, r) => n + r.count, 0);
    if (restored) emitFileChange(req.user.id); // Task5 #5
    // `skipped` tells the client the name is already taken, so it can say so
    // instead of leaving the user staring at an item that stayed in the trash.
    res.json({ restored, skipped });
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
    if (file.hlsReady) await removeHls(file.id);
    await prisma.file.delete({ where: { id: file.id } });
    await subUsage(file.ownerId, totalBytes);
    res.json({ ok: true });
  }),
);

router.post(
  '/empty',
  asyncHandler(async (req, res) => {
    const ownerId = effectiveOwnerId(req);
    // Skip a trashed file that now sits in a LIVE folder — the same rule the
    // retention sweep applies, and the file-side twin of the folder guard below.
    //
    // Restore un-trashes only the ids it is handed and deliberately never walks
    // DOWN into a folder's contents (a user restoring a folder may want only
    // part of it back). So restoring a trashed folder brings the folder back
    // live and listed while every file inside keeps its old stamp. The user
    // sees the rescued folder in their files, then empties the trash to reclaim
    // space — and its contents are hard-deleted out from under them, objects
    // and all. Nothing warns them: the trash view lists those files by name,
    // but they have already decided the folder is a keeper.
    //
    // A file at the root has no folder to have been restored out of, so the
    // trash view is genuinely showing it and it is emptied normally. The
    // per-file DELETE /trash/file/:id is deliberately NOT given this rule —
    // there the user named that one file explicitly.
    const files = (
      await prisma.file.findMany({
        where: { ownerId, trashedAt: { not: null } },
        include: { versions: true, folder: { select: { trashedAt: true } } },
      })
    ).filter((f) => !f.folder || f.folder.trashedAt !== null);
    let total = 0n;
    for (const f of files) {
      for (const v of f.versions) {
        await removeObject(v.objectKey);
        total += BigInt(v.size);
      }
      if (f.thumbnailKey) await removeObject(f.thumbnailKey);
      if (f.hlsReady) await removeHls(f.id);
    }
    // Folder.parent is onDelete: Cascade, so deleting every trashed folder also
    // takes any LIVE descendant with it — and restore un-trashes only the exact
    // ids it is given, so a user who restored a child out of a trashed parent
    // still has that parent sitting in the trash. Emptying would then destroy
    // the folder they just chose to keep and orphan its files to the root
    // (File.folder is SetNull), with their bytes never refunded, because those
    // files were untrashed and so were never in the delete set above. Skip any
    // trashed folder that still has a live descendant.
    const [trashedFolders, survivors] = await Promise.all([
      prisma.folder.findMany({
        where: { ownerId, trashedAt: { not: null } },
        select: { id: true, ownerId: true, path: true },
      }),
      prisma.folder.findMany({
        where: { ownerId, trashedAt: null },
        select: { ownerId: true, path: true },
      }),
    ]);
    const deletableFolders = deletableFolderIds(trashedFolders, survivors);

    // Delete exactly the files whose bytes were counted above. A blanket
    // `deleteMany({ trashedAt: { not: null } })` would ignore the filter and
    // destroy the held-back rows anyway — while `total` refunded less than it
    // removed, leaving the counter permanently overstating what is stored.
    await prisma.$transaction([
      prisma.file.deleteMany({ where: { id: { in: files.map((f) => f.id) } } }),
      prisma.folder.deleteMany({ where: { id: { in: deletableFolders } } }),
    ]);
    await subUsage(ownerId, total);
    res.json({ ok: true, freedBytes: total.toString() });
  }),
);

export default router;
