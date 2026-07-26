// Bulk move: destination scoping and trashed-file handling.
//
// /bulk/move validated the destination folder with `ownerScope(req)` — the
// CALLER's scope — and then moved whatever that same scope matched. For an admin
// `ownerScope` is `{}`, so both halves were unrestricted and an admin could move
// one user's files into a THIRD user's folder: the row keeps its original
// ownerId but now sits in someone else's tree, where that owner and their folder
// grantees can read it. The single-file PATCH already scoped the destination to
// `ownerId: file.ownerId`; this route is the bulk equivalent and owed the same rule.
//
// It was also the only bulk operation that did not filter `trashedAt: null`
// (bulk/trash, bulk/rename and bulk/zip all do), so it relocated items the
// listing hides — they reappeared in a folder the user never chose once restored.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';

vi.mock('../../src/services/storage.service.js', () => ({
  objectKeyFor: (u, e) => `u/${u}/${Math.random().toString(36).slice(2)}.${e}`,
  putObjectStream: vi.fn(async () => {}),
  putObjectBuffer: vi.fn(async () => {}),
  getObjectStream: vi.fn(async () => null),
  getObjectRange: vi.fn(async () => null),
  removeObject: vi.fn(async () => {}),
  statObject: vi.fn(async () => ({ size: 0 })),
  removePrefix: vi.fn(async () => {}),
  presignedGet: vi.fn(async () => 'http://minio.test/object'),
  initiateMultipart: vi.fn(async () => 'test-upload-id'),
  uploadPart: vi.fn(async () => ({})),
  completeMultipart: vi.fn(async () => ({})),
  abortMultipart: vi.fn(async () => {}),
}));

vi.mock('../../src/services/ai.service.js', () => ({
  indexFile: vi.fn(async () => {}),
  syncVectorColumn: vi.fn(async () => {}),
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

const move = (auth, ids, folderId) =>
  request(app).post('/api/files/bulk/move').set('Authorization', auth).send({ ids, folderId });

describe('POST /api/files/bulk/move', () => {
  it('moves the caller’s own files into their own folder', async () => {
    const user = await makeUser();
    const { auth } = await login(user);
    const dest = await makeFolder(user, { name: 'dest' });
    const a = await makeFile(user, { name: 'a.txt' });
    const b = await makeFile(user, { name: 'b.txt' });

    const res = await move(auth, [a.id, b.id], dest.id);
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(2);
    for (const id of [a.id, b.id]) {
      expect((await prisma.file.findUnique({ where: { id } })).folderId).toBe(dest.id);
    }
  });

  it('moves files back to the root', async () => {
    const user = await makeUser();
    const { auth } = await login(user);
    const folder = await makeFolder(user, { name: 'src' });
    const file = await makeFile(user, { name: 'a.txt', folderId: folder.id });

    expect((await move(auth, [file.id], null)).body.count).toBe(1);
    expect((await prisma.file.findUnique({ where: { id: file.id } })).folderId).toBeNull();
  });

  // The leak: the destination must belong to the FILES' owner, never merely to
  // whatever the caller is allowed to see.
  it('refuses to move a user’s files into another user’s folder, even for an admin', async () => {
    const admin = await makeUser({ role: 'admin' });
    const { auth } = await login(admin);
    const victim = await makeUser();
    const stranger = await makeUser();
    const file = await makeFile(victim, { name: 'private.txt' });
    const strangerFolder = await makeFolder(stranger, { name: 'stranger-dest' });

    const res = await move(auth, [file.id], strangerFolder.id);
    expect(res.status).toBe(404);
    expect((await prisma.file.findUnique({ where: { id: file.id } })).folderId).toBeNull();
  });

  it('refuses a single move that spans two owners', async () => {
    const admin = await makeUser({ role: 'admin' });
    const { auth } = await login(admin);
    const one = await makeUser();
    const two = await makeUser();
    const dest = await makeFolder(one, { name: 'dest' });
    const fileOne = await makeFile(one, { name: 'one.txt' });
    const fileTwo = await makeFile(two, { name: 'two.txt' });

    expect((await move(auth, [fileOne.id, fileTwo.id], dest.id)).status).toBe(404);
    expect((await prisma.file.findUnique({ where: { id: fileOne.id } })).folderId).toBeNull();
    expect((await prisma.file.findUnique({ where: { id: fileTwo.id } })).folderId).toBeNull();
  });

  // An admin acting within one user's own tree is still allowed — the rule is
  // about the destination's owner, not about forbidding admin writes.
  it('lets an admin move a user’s files inside that same user’s tree', async () => {
    const admin = await makeUser({ role: 'admin' });
    const { auth } = await login(admin);
    const owner = await makeUser();
    const dest = await makeFolder(owner, { name: 'dest' });
    const file = await makeFile(owner, { name: 'a.txt' });

    expect((await move(auth, [file.id], dest.id)).body.count).toBe(1);
    expect((await prisma.file.findUnique({ where: { id: file.id } })).folderId).toBe(dest.id);
  });

  it('does not move trashed files', async () => {
    const user = await makeUser();
    const { auth } = await login(user);
    const dest = await makeFolder(user, { name: 'dest' });
    const trashed = await makeFile(user, { name: 't.txt', trashedAt: new Date() });
    const live = await makeFile(user, { name: 'live.txt' });

    const res = await move(auth, [trashed.id, live.id], dest.id);
    expect(res.body.count).toBe(1);
    expect((await prisma.file.findUnique({ where: { id: trashed.id } })).folderId).toBeNull();
    expect((await prisma.file.findUnique({ where: { id: live.id } })).folderId).toBe(dest.id);
  });

  it('refuses a trashed destination folder', async () => {
    const user = await makeUser();
    const { auth } = await login(user);
    const dest = await makeFolder(user, { name: 'gone' });
    await prisma.folder.update({ where: { id: dest.id }, data: { trashedAt: new Date() } });
    const file = await makeFile(user, { name: 'a.txt' });

    expect((await move(auth, [file.id], dest.id)).status).toBe(404);
    expect((await prisma.file.findUnique({ where: { id: file.id } })).folderId).toBeNull();
  });

  it('does not move files belonging to someone else for a non-admin', async () => {
    const user = await makeUser();
    const { auth } = await login(user);
    const stranger = await makeUser();
    const dest = await makeFolder(user, { name: 'dest' });
    const theirs = await makeFile(stranger, { name: 'theirs.txt' });

    expect((await move(auth, [theirs.id], dest.id)).body.count).toBe(0);
    expect((await prisma.file.findUnique({ where: { id: theirs.id } })).folderId).toBeNull();
  });
});
