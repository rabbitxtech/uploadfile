// Folder sibling-name uniqueness, against a real database.
//
// `Folder.path` is denormalised from folder NAMES and the codebase treats
// (ownerId, path) as a SUBTREE IDENTITY in three separate places: the soft-delete
// and the rename in folders.routes.js both select descendants with
// `path startsWith parent + '/'`, `deletableFolderIds` decides what a bulk purge
// may cascade into, and `grantCoversFolder` resolves folder shares. Nothing
// enforced that the identity was unique, so two siblings could both sit at
// "/docs" and every one of those prefix queries hit BOTH subtrees at once.
//
// None of this is reachable from the unit suite: it only appears once two real
// folder rows share a path and a path-prefix query runs against them.
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
const { makeUser, login, makeFile } = await import('../helpers/fixtures.js');
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

const createFolder = (auth, body) =>
  request(app).post('/api/folders').set('Authorization', auth).send(body);

describe('folder sibling-name uniqueness', () => {
  it('refuses a second folder with the same name in the same parent', async () => {
    const user = await makeUser();
    const { auth } = await login(user);

    expect((await createFolder(auth, { name: 'docs' })).status).toBe(201);
    expect((await createFolder(auth, { name: 'docs' })).status).toBe(409);

    const rows = await prisma.folder.findMany({ where: { ownerId: user.id } });
    expect(rows).toHaveLength(1);
  });

  // The damage the guard exists to prevent. Both "/docs" folders match the
  // prefix "/docs/", so trashing one reached into the other's subtree: its
  // children and their FILES were trashed while the folder itself stayed live,
  // so the files disappeared from a folder the user never touched.
  it('trashing one folder cannot trash a same-named sibling subtree', async () => {
    const user = await makeUser();
    const { auth } = await login(user);

    const a = (await createFolder(auth, { name: 'docs' })).body;
    // The duplicate is refused, so build the second subtree under a name of its
    // own — the point is that the tree can no longer contain two "/docs".
    const b = (await createFolder(auth, { name: 'docs-2' })).body;
    const subB = (await createFolder(auth, { name: 'sub', parentId: b.id })).body;
    const file = await makeFile(user, { folderId: subB.id });

    expect((await request(app).delete(`/api/folders/${a.id}`).set('Authorization', auth)).status)
      .toBe(200);

    expect((await prisma.folder.findUnique({ where: { id: subB.id } })).trashedAt).toBeNull();
    expect((await prisma.file.findUnique({ where: { id: file.id } })).trashedAt).toBeNull();
  });

  // A rename rewrites every descendant by path prefix. With a duplicate sibling
  // it rewrote the OTHER folder's children too, leaving a child whose path
  // ("/archive/sub") no longer matched its actual parent ("/docs") — a
  // permanently inconsistent tree feeding the grant and cascade checks.
  it('keeps every folder path consistent with its parent after a rename', async () => {
    const user = await makeUser();
    const { auth } = await login(user);

    const a = (await createFolder(auth, { name: 'docs' })).body;
    const b = (await createFolder(auth, { name: 'docs-2' })).body;
    const subB = (await createFolder(auth, { name: 'sub', parentId: b.id })).body;

    expect(
      (await request(app).patch(`/api/folders/${a.id}`).set('Authorization', auth)
        .send({ name: 'archive' })).status,
    ).toBe(200);

    const all = await prisma.folder.findMany({ where: { ownerId: user.id } });
    const byId = new Map(all.map((f) => [f.id, f]));
    for (const folder of all) {
      const expected = folder.parentId
        ? `${byId.get(folder.parentId).path}/${folder.name}`
        : `/${folder.name}`;
      expect(folder.path).toBe(expected);
    }
    expect(byId.get(subB.id).path).toBe('/docs-2/sub');
  });

  it('refuses a rename onto an existing sibling', async () => {
    const user = await makeUser();
    const { auth } = await login(user);
    await createFolder(auth, { name: 'docs' });
    const other = (await createFolder(auth, { name: 'photos' })).body;

    const res = await request(app).patch(`/api/folders/${other.id}`).set('Authorization', auth)
      .send({ name: 'docs' });
    expect(res.status).toBe(409);
    expect((await prisma.folder.findUnique({ where: { id: other.id } })).path).toBe('/photos');
  });

  // The guard must not over-reach: these are all legitimate and stayed working.
  it('allows the same name under different parents', async () => {
    const user = await makeUser();
    const { auth } = await login(user);
    const p1 = (await createFolder(auth, { name: 'p1' })).body;
    const p2 = (await createFolder(auth, { name: 'p2' })).body;

    expect((await createFolder(auth, { name: 'sub', parentId: p1.id })).body.path).toBe('/p1/sub');
    expect((await createFolder(auth, { name: 'sub', parentId: p2.id })).body.path).toBe('/p2/sub');
  });

  it('allows two different users to each own /docs', async () => {
    const one = await makeUser();
    const two = await makeUser();
    expect((await createFolder((await login(one)).auth, { name: 'docs' })).status).toBe(201);
    expect((await createFolder((await login(two)).auth, { name: 'docs' })).status).toBe(201);
  });

  // Uniqueness is scoped to LIVE folders: a trashed folder keeps its path, and
  // must not block the user from re-creating that name.
  it('allows re-creating a name whose previous folder is in the trash', async () => {
    const user = await makeUser();
    const { auth } = await login(user);
    const first = (await createFolder(auth, { name: 'docs' })).body;
    await request(app).delete(`/api/folders/${first.id}`).set('Authorization', auth);

    expect((await createFolder(auth, { name: 'docs' })).status).toBe(201);
  });

  it('allows a no-op rename and a move that keeps the name', async () => {
    const user = await makeUser();
    const { auth } = await login(user);
    const parent = (await createFolder(auth, { name: 'parent' })).body;
    const solo = (await createFolder(auth, { name: 'docs' })).body;

    // Renaming a folder to the name it already has must not collide with itself.
    expect(
      (await request(app).patch(`/api/folders/${solo.id}`).set('Authorization', auth)
        .send({ name: 'docs' })).status,
    ).toBe(200);

    const moved = await request(app).patch(`/api/folders/${solo.id}`).set('Authorization', auth)
      .send({ parentId: parent.id });
    expect(moved.status).toBe(200);
    expect(moved.body.path).toBe('/parent/docs');
  });

  // A trashed folder is hidden from every listing, so a child created inside one
  // would be live but unreachable until the parent happened to be restored.
  it('refuses to create a folder inside a trashed parent', async () => {
    const user = await makeUser();
    const { auth } = await login(user);
    const parent = (await createFolder(auth, { name: 'parent' })).body;
    await request(app).delete(`/api/folders/${parent.id}`).set('Authorization', auth);

    expect((await createFolder(auth, { name: 'child', parentId: parent.id })).status).toBe(404);
  });
});
