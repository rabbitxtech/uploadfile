// Integration coverage for the WebDAV MOVE path, against a real database.
//
// MOVE is the second way into the folder tree (the REST rename is the first) and
// the only one that could rename a folder onto a live sibling's path, or land a
// second live file under one name in a folder. Both are invariants the rest of
// the codebase reads as identities — (ownerId, path) for a folder subtree,
// (ownerId, folderId, name) for the file a WebDAV client resolves — so neither
// is reachable from the unit suite: they only misbehave once real sibling rows
// exist for the prefix queries to hit.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';

vi.mock('../../src/services/storage.service.js', () => ({
  objectKeyFor: (userId, ext) => `u/${userId}/${Math.random().toString(36).slice(2)}.${ext}`,
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
const { makeUser, makeFolder, makeFile } = await import('../helpers/fixtures.js');
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

const basic = (user) =>
  'Basic ' + Buffer.from(`${user.email}:${user.password}`).toString('base64');

describe('WebDAV MOVE — folder path collisions', () => {
  it('refuses to rename a folder onto a live sibling path', async () => {
    const user = await makeUser();
    await makeFolder(user, { name: 'docs' });
    const archive = await makeFolder(user, { name: 'archive' });

    // Renaming /archive → /docs would put two LIVE folders on one path. Every
    // prefix query in the codebase (soft-delete, rename, deletableFolderIds,
    // grantCoversFolder) then matches BOTH subtrees.
    const res = await request(app)
      .move('/webdav/archive')
      .set('Authorization', basic(user))
      .set('Destination', '/webdav/docs');
    expect(res.status).toBe(412);

    // ...and the rejected move changed nothing.
    const after = await prisma.folder.findUnique({ where: { id: archive.id } });
    expect(after.path).toBe('/archive');

    const atDocs = await prisma.folder.findMany({
      where: { ownerId: user.id, path: '/docs', trashedAt: null },
    });
    expect(atDocs).toHaveLength(1);
  });

  it('allows a rename onto a path only a TRASHED folder holds', async () => {
    // A trashed folder keeps its path and must not block a re-create/rename —
    // the REST check is scoped to trashedAt: null for exactly this reason.
    const user = await makeUser();
    const old = await makeFolder(user, { name: 'docs' });
    await prisma.folder.update({ where: { id: old.id }, data: { trashedAt: new Date() } });
    const archive = await makeFolder(user, { name: 'archive' });

    const res = await request(app)
      .move('/webdav/archive')
      .set('Authorization', basic(user))
      .set('Destination', '/webdav/docs');
    expect(res.status).toBe(201);

    const after = await prisma.folder.findUnique({ where: { id: archive.id } });
    expect(after.path).toBe('/docs');
  });

  it("does not let one owner's folder block another's identical path", async () => {
    // Folder.path is names-only and NOT namespaced per owner — two users can
    // each own /docs. Scoping the collision check to the caller is what keeps a
    // stranger's folder from making this a 412.
    const a = await makeUser();
    const b = await makeUser();
    await makeFolder(a, { name: 'docs' });
    await makeFolder(b, { name: 'archive' });

    const res = await request(app)
      .move('/webdav/archive')
      .set('Authorization', basic(b))
      .set('Destination', '/webdav/docs');
    expect(res.status).toBe(201);
  });

  it('still allows a plain rename to a free name', async () => {
    const user = await makeUser();
    const f = await makeFolder(user, { name: 'archive' });

    const res = await request(app)
      .move('/webdav/archive')
      .set('Authorization', basic(user))
      .set('Destination', '/webdav/reports');
    expect(res.status).toBe(201);

    const after = await prisma.folder.findUnique({ where: { id: f.id } });
    expect(after.path).toBe('/reports');
    expect(after.name).toBe('reports');
  });

  it('rewrites descendant paths on a successful move', async () => {
    const user = await makeUser();
    const parent = await makeFolder(user, { name: 'archive' });
    const child = await makeFolder(user, { name: '2025', parentId: parent.id });

    const res = await request(app)
      .move('/webdav/archive')
      .set('Authorization', basic(user))
      .set('Destination', '/webdav/reports');
    expect(res.status).toBe(201);

    // A descendant left on the old prefix is a permanently inconsistent tree,
    // which is what feeds the grant and cascade checks.
    const after = await prisma.folder.findUnique({ where: { id: child.id } });
    expect(after.path).toBe('/reports/2025');
  });
});

describe('WebDAV MOVE — file name collisions', () => {
  it('replaces the displaced file instead of leaving two under one name', async () => {
    const user = await makeUser();
    const folder = await makeFolder(user, { name: 'inbox' });
    const moving = await makeFile(user, { name: 'a.txt', folderId: folder.id, size: 100 });
    const target = await makeFile(user, { name: 'b.txt', folderId: folder.id, size: 200 });

    const res = await request(app)
      .move('/webdav/inbox/a.txt')
      .set('Authorization', basic(user))
      .set('Destination', '/webdav/inbox/b.txt');
    expect(res.status).toBe(204);

    // Exactly one live b.txt, and it is the file that was moved. Leaving both
    // live makes which one a client reads/overwrites/deletes a matter of row
    // order, and strands the other as unreachable-but-billed.
    const live = await prisma.file.findMany({
      where: { ownerId: user.id, folderId: folder.id, name: 'b.txt', trashedAt: null },
    });
    expect(live).toHaveLength(1);
    expect(live[0].id).toBe(moving.id);

    // The displaced file is trashed, not hard-deleted: its bytes stay on the
    // quota and the existing trash/retention paths refund them.
    const displaced = await prisma.file.findUnique({ where: { id: target.id } });
    expect(displaced.trashedAt).not.toBeNull();
  });

  it('honours Overwrite: F by failing with 412', async () => {
    const user = await makeUser();
    const folder = await makeFolder(user, { name: 'inbox' });
    await makeFile(user, { name: 'a.txt', folderId: folder.id, size: 100 });
    const target = await makeFile(user, { name: 'b.txt', folderId: folder.id, size: 200 });

    const res = await request(app)
      .move('/webdav/inbox/a.txt')
      .set('Authorization', basic(user))
      .set('Destination', '/webdav/inbox/b.txt')
      .set('Overwrite', 'F');
    expect(res.status).toBe(412);

    // Nothing moved and nothing was trashed.
    const untouched = await prisma.file.findUnique({ where: { id: target.id } });
    expect(untouched.trashedAt).toBeNull();
    const stillThere = await prisma.file.findFirst({
      where: { ownerId: user.id, folderId: folder.id, name: 'a.txt', trashedAt: null },
    });
    expect(stillThere).not.toBeNull();
  });

  it('does not treat a TRASHED file at the destination as a collision', async () => {
    const user = await makeUser();
    const folder = await makeFolder(user, { name: 'inbox' });
    const moving = await makeFile(user, { name: 'a.txt', folderId: folder.id, size: 100 });
    const trashed = await makeFile(user, { name: 'b.txt', folderId: folder.id, size: 200 });
    await prisma.file.update({ where: { id: trashed.id }, data: { trashedAt: new Date() } });

    const res = await request(app)
      .move('/webdav/inbox/a.txt')
      .set('Authorization', basic(user))
      .set('Destination', '/webdav/inbox/b.txt');
    expect(res.status).toBe(201); // a plain move, nothing displaced

    const after = await prisma.file.findUnique({ where: { id: moving.id } });
    expect(after.name).toBe('b.txt');
  });

  it('still allows a plain file rename to a free name', async () => {
    const user = await makeUser();
    const folder = await makeFolder(user, { name: 'inbox' });
    const f = await makeFile(user, { name: 'a.txt', folderId: folder.id, size: 100 });

    const res = await request(app)
      .move('/webdav/inbox/a.txt')
      .set('Authorization', basic(user))
      .set('Destination', '/webdav/inbox/c.txt');
    expect(res.status).toBe(201);

    const after = await prisma.file.findUnique({ where: { id: f.id } });
    expect(after.name).toBe('c.txt');
  });
});
