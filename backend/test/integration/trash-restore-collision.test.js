// Restoring from the trash must not land two live rows on one name.
//
// Every OTHER name-choosing path in this codebase enforces the one-name-one-
// resource rule: `assertNoSiblingCollision` (folder create/rename/move),
// `findFileNameClash`/`findFolderNameClash` (file rename, bulk rename, bulk
// move, single-shot upload, from-url, from-youtube, the drop-box, upload/init)
// and WebDAV's MKCOL/PUT/MOVE. `POST /trash/restore` was the one that had no
// check at all — it did a blind `updateMany({ id: { in: ids } }, { trashedAt:
// null })`.
//
// That matters because those checks are deliberately scoped to `trashedAt:
// null`: a trashed row keeps its name and must NOT block re-creating one, since
// it is on its way out and invisible to every listing. That carve-out is what
// makes the collision reachable — the sequence is ordinary housekeeping, not an
// attack:
//
//   1. delete a folder "docs"        -> the row is trashed, keeps path "/docs"
//   2. create a new folder "docs"    -> allowed, by design
//   3. restore the old one from trash -> TWO live folders at "/docs"
//
// And two live folders on one path is the exact state `assertNoSiblingCollision`
// exists to prevent, because three separate layers read (ownerId, path) as a
// SUBTREE IDENTITY:
//
//   - the folder soft-delete and the rename both select descendants with
//     `path startsWith parent + '/'`, so deleting one "/docs" trashes the
//     OTHER's children and their files, and renaming one rewrites the other's
//     descendants into a tree whose children no longer match their parent;
//   - `deletableFolderIds` decides what a bulk purge may cascade into;
//   - `grantCoversFolder` resolves folder shares.
//
// The file-vs-folder direction is worse than a duplicate: WebDAV's PROPFIND
// tries `findFolder` before `findFile` and answers <D:collection/>, and DELETE
// takes the folder branch — so the file at that path is live, billed against
// the owner's quota, and both unreadable and undeletable over WebDAV. That is
// the same "live, billed, reachable from neither view" state the trashed-parent
// gates and the restore-ancestor walk exist to prevent.
//
// The ANCESTOR WALK reaches it too: restoring a single FILE un-trashes its
// whole parent chain, so one click on one file is enough to resurrect a folder
// onto a live path the user never named in the request.
//
// Needs a real database: the defect is entirely in which rows the where-clauses
// match, and the parent chain lives in the schema.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';

vi.mock('../../src/services/storage.service.js', () => ({
  removeObject: vi.fn(async () => {}),
  removePrefix: vi.fn(async () => {}),
  objectKeyFor: (userId, ext) => `u/${userId}/${Math.random().toString(36).slice(2)}.${ext}`,
  presignedGet: vi.fn(async () => 'http://minio.test/o'),
}));
vi.mock('../../src/services/hls.service.js', () => ({
  removeHls: vi.fn(async () => {}),
  hlsPrefix: (id) => `h/${id}/`,
}));

const { prisma, migrateTestDb, resetDb, disconnect } = await import('../helpers/db.js');
const { makeUser, login, makeFile, makeFolder } = await import('../helpers/fixtures.js');
const { buildApp } = await import('../../src/app.js');

const app = buildApp();

beforeAll(() => {
  migrateTestDb();
}, 120_000);

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await disconnect();
});

// Trash a folder exactly as DELETE /api/folders/:id does: stamp the folder, its
// descendants (by path prefix) and every file inside them with one timestamp.
async function trashFolderTree(owner, folder) {
  const now = new Date();
  const prefix = folder.path === '/' ? '/' : folder.path + '/';
  await prisma.$transaction([
    prisma.folder.updateMany({
      where: { ownerId: owner.id, OR: [{ id: folder.id }, { path: { startsWith: prefix } }] },
      data: { trashedAt: now },
    }),
    prisma.file.updateMany({
      where: {
        ownerId: owner.id,
        folder: { OR: [{ id: folder.id }, { path: { startsWith: prefix } }] },
      },
      data: { trashedAt: now },
    }),
  ]);
}

describe('POST /trash/restore — one name, one live resource', () => {
  it('refuses to restore a folder onto a path a live folder now holds', async () => {
    const user = await makeUser();
    const { auth } = await login(user);

    const original = await makeFolder(user, { name: 'docs' });
    await trashFolderTree(user, original);

    // Re-creating the name while the old row sits in the trash is explicitly
    // allowed — the collision checks are scoped to `trashedAt: null` on purpose.
    const recreate = await request(app)
      .post('/api/folders')
      .set('Authorization', auth)
      .send({ name: 'docs' });
    expect(recreate.status).toBe(201);

    const res = await request(app)
      .post('/api/trash/restore')
      .set('Authorization', auth)
      .send({ folderIds: [original.id] });

    // The restore must not silently produce the duplicate.
    const live = await prisma.folder.findMany({
      where: { ownerId: user.id, path: '/docs', trashedAt: null },
    });
    expect(live).toHaveLength(1);
    expect(live[0].id).toBe(recreate.body.id);

    // The blocked item stays in the trash rather than vanishing, and the route
    // reports what it could not restore instead of failing the whole request.
    const still = await prisma.folder.findUnique({ where: { id: original.id } });
    expect(still.trashedAt).not.toBeNull();
    expect(res.status).toBe(200);
    expect(res.body.restored).toBe(0);
    expect(res.body.skipped).toBe(1);
  });

  it('refuses to restore a folder onto a live FILE of the same name', async () => {
    const user = await makeUser();
    const { auth } = await login(user);

    const box = await makeFolder(user, { name: 'box' });
    const inner = await makeFolder(user, { name: 'data', parentId: box.id });
    await trashFolderTree(user, inner);

    // A live file takes the freed name.
    await makeFile(user, { name: 'data', folderId: box.id });

    const res = await request(app)
      .post('/api/trash/restore')
      .set('Authorization', auth)
      .send({ folderIds: [inner.id] });

    // A folder shadows a file outright over WebDAV, so this direction must be
    // refused as firmly as folder-vs-folder.
    const liveFolder = await prisma.folder.findFirst({
      where: { ownerId: user.id, parentId: box.id, name: 'data', trashedAt: null },
    });
    expect(liveFolder).toBeNull();
    expect(res.body.skipped).toBe(1);
  });

  it('refuses to restore a file onto a live FOLDER of the same name', async () => {
    const user = await makeUser();
    const { auth } = await login(user);

    const box = await makeFolder(user, { name: 'box' });
    const file = await makeFile(user, { name: 'notes', folderId: box.id });
    await prisma.file.update({ where: { id: file.id }, data: { trashedAt: new Date() } });

    await makeFolder(user, { name: 'notes', parentId: box.id });

    const res = await request(app)
      .post('/api/trash/restore')
      .set('Authorization', auth)
      .send({ fileIds: [file.id] });

    const liveFile = await prisma.file.findFirst({
      where: { ownerId: user.id, folderId: box.id, name: 'notes', trashedAt: null },
    });
    expect(liveFile).toBeNull();
    const stillTrashed = await prisma.file.findUnique({ where: { id: file.id } });
    expect(stillTrashed.trashedAt).not.toBeNull();
    expect(res.body.skipped).toBe(1);
  });

  it('does not resurrect an ANCESTOR onto a live path when restoring a file', async () => {
    const user = await makeUser();
    const { auth } = await login(user);

    const proj = await makeFolder(user, { name: 'proj' });
    const file = await makeFile(user, { name: 'x.txt', folderId: proj.id });
    await trashFolderTree(user, proj);

    const recreate = await request(app)
      .post('/api/folders')
      .set('Authorization', auth)
      .send({ name: 'proj' });
    expect(recreate.status).toBe(201);

    // Restoring the FILE walks up and un-trashes its parent chain. That walk is
    // what makes the row reachable again, but it must not put the old "/proj"
    // back alongside the new one.
    await request(app)
      .post('/api/trash/restore')
      .set('Authorization', auth)
      .send({ fileIds: [file.id] });

    const live = await prisma.folder.findMany({
      where: { ownerId: user.id, path: '/proj', trashedAt: null },
    });
    expect(live).toHaveLength(1);
    expect(live[0].id).toBe(recreate.body.id);

    // The file must not be left live under a still-trashed ancestor either —
    // that is the unreachable state the ancestor walk exists to prevent. Held
    // back in the trash is the correct answer when its chain cannot be restored.
    const f = await prisma.file.findUnique({ where: { id: file.id } });
    expect(f.trashedAt).not.toBeNull();
  });

  // ---- control cases: the rule must not break ordinary restores ----

  it('still restores a folder whose name is free', async () => {
    const user = await makeUser();
    const { auth } = await login(user);

    const folder = await makeFolder(user, { name: 'reports' });
    await trashFolderTree(user, folder);

    const res = await request(app)
      .post('/api/trash/restore')
      .set('Authorization', auth)
      .send({ folderIds: [folder.id] });

    expect(res.status).toBe(200);
    expect(res.body.restored).toBe(1);
    expect(res.body.skipped ?? 0).toBe(0);
    const back = await prisma.folder.findUnique({ where: { id: folder.id } });
    expect(back.trashedAt).toBeNull();
  });

  it('still restores a file out of a trashed folder, ancestors and all', async () => {
    const user = await makeUser();
    const { auth } = await login(user);

    const parent = await makeFolder(user, { name: 'archive' });
    const child = await makeFolder(user, { name: 'q1', parentId: parent.id });
    const file = await makeFile(user, { name: 'note.txt', folderId: child.id });
    await trashFolderTree(user, parent);

    const res = await request(app)
      .post('/api/trash/restore')
      .set('Authorization', auth)
      .send({ fileIds: [file.id] });

    expect(res.body.restored).toBe(1);
    const f = await prisma.file.findUnique({ where: { id: file.id } });
    expect(f.trashedAt).toBeNull();
    // Both ancestors come back so the file is actually reachable.
    for (const id of [parent.id, child.id]) {
      const row = await prisma.folder.findUnique({ where: { id } });
      expect(row.trashedAt).toBeNull();
    }
  });

  it('two files of the same name may both be restored (file-vs-file is allowed)', async () => {
    const user = await makeUser();
    const { auth } = await login(user);

    const box = await makeFolder(user, { name: 'box' });
    const a = await makeFile(user, { name: 'report.pdf', folderId: box.id });
    await prisma.file.update({ where: { id: a.id }, data: { trashedAt: new Date() } });
    // Uploading a second "report.pdf" is long-standing product behaviour (the
    // Uploader offers a replace), and both rows stay visible in the REST
    // listing — so restore must not invent a stricter rule than upload has.
    await makeFile(user, { name: 'report.pdf', folderId: box.id });

    const res = await request(app)
      .post('/api/trash/restore')
      .set('Authorization', auth)
      .send({ fileIds: [a.id] });

    expect(res.body.restored).toBe(1);
    const live = await prisma.file.findMany({
      where: { ownerId: user.id, folderId: box.id, name: 'report.pdf', trashedAt: null },
    });
    expect(live).toHaveLength(2);
  });
});
