// Restoring from the trash must produce a row the user can actually reach.
//
// `trashedAt` is per-row, but "where a file lives" is a parent chain — and both
// listings read only the row's own flag:
//
//   GET /api/folders  lists `{ ownerId, trashedAt: null, parentId }`
//   GET /api/trash    lists `{ ownerId, trashedAt: { not: null } }`
//
// So a row whose own `trashedAt` is null while an ANCESTOR is still trashed
// satisfies neither listing. It is not in the trash (its flag is clear) and it
// is not in My Files (the browse path stops at the trashed ancestor, which the
// folder listing hides). The row is live, still billed against the owner's
// quota, and unreachable through the UI — with no error at any point.
//
// `POST /trash/restore` un-trashed exactly the ids it was handed, so this was
// reachable in one click: the Trash page lists trashed files and trashed
// folders in two separate tables, and restoring a file out of that list while
// its parent folder stays trashed is the ordinary way to use it.
//
// The retention sweep already defends against the MIRROR of this (a restored
// child under an expired parent — see retention.test.js and foldercascade.js);
// that guard keeps the sweep from destroying the child, which is precisely what
// leaves the inconsistent state sitting there indefinitely rather than being
// cleaned up. Fixing restore is what stops it being created.
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
// descendant folders, and every file under any of them with one timestamp.
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
  return now;
}

describe('POST /trash/restore — a restored row must be reachable', () => {
  // The headline case. One file, one trashed folder, one click on "Restore"
  // next to the file in the Trash page's file table.
  it('restores the file\'s trashed ancestor folders too', async () => {
    const user = await makeUser();
    const { auth } = await login(user);
    const folder = await makeFolder(user, { name: 'docs' });
    const file = await makeFile(user, { name: 'report.pdf', folderId: folder.id });
    await trashFolderTree(user, folder);

    const res = await request(app)
      .post('/api/trash/restore')
      .set('Authorization', auth)
      .send({ fileIds: [file.id] });
    expect(res.status).toBe(200);

    // The file is live...
    const restored = await prisma.file.findUnique({ where: { id: file.id } });
    expect(restored.trashedAt).toBeNull();
    // ...and so is the folder it lives in, or it cannot be browsed to.
    const parent = await prisma.folder.findUnique({ where: { id: folder.id } });
    expect(parent.trashedAt).toBeNull();

    // The end-to-end assertion: the file appears in the folder listing.
    const list = await request(app)
      .get('/api/folders')
      .query({ parentId: folder.id })
      .set('Authorization', auth);
    expect(list.status).toBe(200);
    expect(list.body.files.map((f) => f.id)).toContain(file.id);
  });

  // The whole chain has to come back, not just the immediate parent — the
  // listing walks from the root, so ANY trashed link in the chain hides it.
  it('restores the whole ancestor chain, not just the immediate parent', async () => {
    const user = await makeUser();
    const { auth } = await login(user);
    const top = await makeFolder(user, { name: 'top' });
    const mid = await makeFolder(user, { name: 'mid', parentId: top.id });
    const leaf = await makeFolder(user, { name: 'leaf', parentId: mid.id });
    const file = await makeFile(user, { name: 'deep.txt', folderId: leaf.id });
    await trashFolderTree(user, top);

    await request(app)
      .post('/api/trash/restore')
      .set('Authorization', auth)
      .send({ fileIds: [file.id] })
      .expect(200);

    for (const f of [top, mid, leaf]) {
      const row = await prisma.folder.findUnique({ where: { id: f.id } });
      expect(row.trashedAt, `${f.name} should be restored`).toBeNull();
    }
  });

  // Restoring a folder owes the same walk upward.
  it('restores ancestors when a folder is the restore target', async () => {
    const user = await makeUser();
    const { auth } = await login(user);
    const top = await makeFolder(user, { name: 'top' });
    const child = await makeFolder(user, { name: 'child', parentId: top.id });
    await trashFolderTree(user, top);

    await request(app)
      .post('/api/trash/restore')
      .set('Authorization', auth)
      .send({ folderIds: [child.id] })
      .expect(200);

    const parent = await prisma.folder.findUnique({ where: { id: top.id } });
    expect(parent.trashedAt).toBeNull();
    const restored = await prisma.folder.findUnique({ where: { id: child.id } });
    expect(restored.trashedAt).toBeNull();
  });

  // Restoring upward must NOT restore downward: the user picked one file out of
  // a trashed folder, and the folder's other contents stay in the trash. This is
  // the boundary that keeps the fix from becoming "restore the whole subtree".
  it('does not restore the ancestor\'s other trashed contents', async () => {
    const user = await makeUser();
    const { auth } = await login(user);
    const folder = await makeFolder(user, { name: 'docs' });
    const wanted = await makeFile(user, { name: 'wanted.txt', folderId: folder.id });
    const other = await makeFile(user, { name: 'other.txt', folderId: folder.id });
    const sub = await makeFolder(user, { name: 'sub', parentId: folder.id });
    await trashFolderTree(user, folder);

    await request(app)
      .post('/api/trash/restore')
      .set('Authorization', auth)
      .send({ fileIds: [wanted.id] })
      .expect(200);

    expect((await prisma.file.findUnique({ where: { id: other.id } })).trashedAt).not.toBeNull();
    expect((await prisma.folder.findUnique({ where: { id: sub.id } })).trashedAt).not.toBeNull();
    // The ancestor itself is back, which is what makes `wanted` reachable.
    expect((await prisma.folder.findUnique({ where: { id: folder.id } })).trashedAt).toBeNull();
  });

  // A live ancestor is the normal case (a file trashed on its own) and must not
  // be disturbed — in particular the restore must not clear a timestamp that was
  // never set, nor touch rows it has no reason to write.
  it('leaves an already-live parent alone', async () => {
    const user = await makeUser();
    const { auth } = await login(user);
    const folder = await makeFolder(user, { name: 'docs' });
    const file = await makeFile(user, { name: 'solo.txt', folderId: folder.id });
    await prisma.file.update({ where: { id: file.id }, data: { trashedAt: new Date() } });

    await request(app)
      .post('/api/trash/restore')
      .set('Authorization', auth)
      .send({ fileIds: [file.id] })
      .expect(200);

    expect((await prisma.file.findUnique({ where: { id: file.id } })).trashedAt).toBeNull();
    expect((await prisma.folder.findUnique({ where: { id: folder.id } })).trashedAt).toBeNull();
  });

  // The ancestor walk must stay inside the caller's own rows. Folder.path is not
  // namespaced per owner, and an id handed in by a client is not proof of
  // ownership — the restore itself is owner-scoped, so the walk has to be too.
  it('does not touch another owner\'s folders', async () => {
    const user = await makeUser();
    const stranger = await makeUser();
    const { auth } = await login(user);

    const strangerFolder = await makeFolder(stranger, { name: 'docs' });
    await trashFolderTree(stranger, strangerFolder);
    const strangerFile = await makeFile(stranger, {
      name: 'theirs.txt',
      folderId: strangerFolder.id,
      trashedAt: new Date(),
    });

    // A non-admin restoring someone else's file must change nothing at all.
    const res = await request(app)
      .post('/api/trash/restore')
      .set('Authorization', auth)
      .send({ fileIds: [strangerFile.id] });
    expect(res.status).toBe(200);
    expect(res.body.restored).toBe(0);
    expect(
      (await prisma.folder.findUnique({ where: { id: strangerFolder.id } })).trashedAt,
    ).not.toBeNull();
    expect(
      (await prisma.file.findUnique({ where: { id: strangerFile.id } })).trashedAt,
    ).not.toBeNull();
  });

  // An admin may restore another user's item; the ancestor walk must follow the
  // FILE's owner, not the caller's, or it silently restores nothing.
  it('restores ancestors by the item owner when an admin does it', async () => {
    const owner = await makeUser();
    const admin = await makeUser({ role: 'admin' });
    const { auth } = await login(admin);
    const folder = await makeFolder(owner, { name: 'docs' });
    const file = await makeFile(owner, { name: 'report.pdf', folderId: folder.id });
    await trashFolderTree(owner, folder);

    await request(app)
      .post('/api/trash/restore')
      .set('Authorization', auth)
      .send({ fileIds: [file.id] })
      .expect(200);

    expect((await prisma.folder.findUnique({ where: { id: folder.id } })).trashedAt).toBeNull();
    expect((await prisma.file.findUnique({ where: { id: file.id } })).trashedAt).toBeNull();
  });

  // Restoring several items across different trees resolves every chain.
  it('handles a mixed batch of files and folders', async () => {
    const user = await makeUser();
    const { auth } = await login(user);
    const a = await makeFolder(user, { name: 'alpha' });
    const aSub = await makeFolder(user, { name: 'sub', parentId: a.id });
    const aFile = await makeFile(user, { name: 'a.txt', folderId: aSub.id });
    const b = await makeFolder(user, { name: 'beta' });
    const bSub = await makeFolder(user, { name: 'sub', parentId: b.id });
    await trashFolderTree(user, a);
    await trashFolderTree(user, b);

    await request(app)
      .post('/api/trash/restore')
      .set('Authorization', auth)
      .send({ fileIds: [aFile.id], folderIds: [bSub.id] })
      .expect(200);

    for (const f of [a, aSub, b, bSub]) {
      expect(
        (await prisma.folder.findUnique({ where: { id: f.id } })).trashedAt,
        `${f.path} should be restored`,
      ).toBeNull();
    }
  });

  // A file at the root has no ancestor chain; the walk must simply do nothing
  // rather than, say, matching every root-level folder.
  it('restores a root-level file without touching any folder', async () => {
    const user = await makeUser();
    const { auth } = await login(user);
    const untouched = await makeFolder(user, { name: 'docs' });
    await trashFolderTree(user, untouched);
    const file = await makeFile(user, { name: 'root.txt', trashedAt: new Date() });

    await request(app)
      .post('/api/trash/restore')
      .set('Authorization', auth)
      .send({ fileIds: [file.id] })
      .expect(200);

    expect((await prisma.file.findUnique({ where: { id: file.id } })).trashedAt).toBeNull();
    // The unrelated trashed folder stays trashed.
    expect(
      (await prisma.folder.findUnique({ where: { id: untouched.id } })).trashedAt,
    ).not.toBeNull();
  });
});
