// PATCH /api/files/:id must not rename or move a trashed file.
//
// The route resolved its target with a bare `findUnique({ where: { id } })` and
// no `trashedAt` filter, so it wrote to a file sitting in the trash. This is the
// same defect `/bulk/move` was fixed for — and this is the route the UI actually
// drives for a single rename or a drag-and-drop move, so it is the reachable one.
//
// Moving a trashed file relocates an item the listing hides: the user sees
// nothing happen, and the file later reappears on restore in a folder they never
// put it in. Renaming one is the quieter half — the trash view lists the name, so
// the entry the user is looking for changes out from under them.
//
// Note `ownedWhere`-style admin widening is not what saves this: `fileAccessLevel`
// returns 'admin' for any file, so for an admin the trashed gate is the only
// thing between them and this write, exactly as with the version upload.
//
// The star toggle and the soft-delete deliberately still work on a trashed row,
// so this must not be applied blanket-wide — see the "still works" cases below.
//
// Needs a real database: the fix is a where-clause, so it either filters the row
// or it doesn't.
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
}));
vi.mock('../../src/services/ai.service.js', () => ({
  indexFile: vi.fn(async () => {}),
  queueIndexFile: vi.fn(async () => {}),
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

const patch = (auth, id, body) =>
  request(app).patch(`/api/files/${id}`).set('Authorization', auth).send(body);

describe('PATCH /api/files/:id on a trashed file', () => {
  it('refuses to move a trashed file into a folder', async () => {
    const user = await makeUser();
    const { auth } = await login(user);
    const dest = await makeFolder(user, { name: 'dest' });
    const file = await makeFile(user, { name: 'a.txt', trashedAt: new Date() });

    const res = await patch(auth, file.id, { folderId: dest.id });
    expect(res.status).toBe(404);

    const after = await prisma.file.findUnique({ where: { id: file.id } });
    expect(after.folderId).toBeNull();
    expect(after.trashedAt).not.toBeNull();
  });

  it('refuses to rename a trashed file', async () => {
    const user = await makeUser();
    const { auth } = await login(user);
    const file = await makeFile(user, { name: 'original.txt', trashedAt: new Date() });

    const res = await patch(auth, file.id, { name: 'renamed.txt' });
    expect(res.status).toBe(404);

    const after = await prisma.file.findUnique({ where: { id: file.id } });
    expect(after.name).toBe('original.txt');
  });

  it('refuses to retag a trashed file', async () => {
    const user = await makeUser();
    const { auth } = await login(user);
    const file = await makeFile(user, { name: 'a.txt', trashedAt: new Date() });

    const res = await patch(auth, file.id, { tags: ['later'] });
    expect(res.status).toBe(404);

    const after = await prisma.file.findUnique({
      where: { id: file.id },
      include: { tags: true },
    });
    expect(after.tags).toHaveLength(0);
  });

  // fileAccessLevel returns 'admin' for any file, so the trashed gate is the
  // only check standing between an admin and this write.
  it('refuses for an admin acting on someone else’s trashed file', async () => {
    const owner = await makeUser();
    const admin = await makeUser({ role: 'admin' });
    const { auth } = await login(admin);
    const dest = await makeFolder(owner, { name: 'dest' });
    const file = await makeFile(owner, { name: 'a.txt', trashedAt: new Date() });

    const res = await patch(auth, file.id, { folderId: dest.id });
    expect(res.status).toBe(404);
    expect((await prisma.file.findUnique({ where: { id: file.id } })).folderId).toBeNull();
  });

  // The gate must be on the file, not blanket-applied: a live file still moves,
  // renames and retags exactly as before.
  it('still moves and renames a live file', async () => {
    const user = await makeUser();
    const { auth } = await login(user);
    const dest = await makeFolder(user, { name: 'dest' });
    const file = await makeFile(user, { name: 'live.txt' });

    const res = await patch(auth, file.id, { folderId: dest.id, name: 'moved.txt' });
    expect(res.status).toBe(200);

    const after = await prisma.file.findUnique({ where: { id: file.id } });
    expect(after.folderId).toBe(dest.id);
    expect(after.name).toBe('moved.txt');
  });

  // The soft-delete must keep working on a trashed row — it is how the trash is
  // reached in the first place, and re-trashing must not start 404ing.
  it('still allows the soft-delete of an already-trashed file', async () => {
    const user = await makeUser();
    const { auth } = await login(user);
    const file = await makeFile(user, { name: 'a.txt', trashedAt: new Date() });

    const res = await request(app)
      .delete(`/api/files/${file.id}`)
      .set('Authorization', auth);
    expect(res.status).toBe(200);
    expect((await prisma.file.findUnique({ where: { id: file.id } })).trashedAt).not.toBeNull();
  });

  // The star toggle deliberately still works on a trashed row.
  it('still allows starring a trashed file', async () => {
    const user = await makeUser();
    const { auth } = await login(user);
    const file = await makeFile(user, { name: 'a.txt', trashedAt: new Date() });

    const res = await request(app)
      .post(`/api/files/${file.id}/star`)
      .set('Authorization', auth);
    expect(res.status).toBe(200);
    expect((await prisma.file.findUnique({ where: { id: file.id } })).starred).toBe(true);
  });
});
