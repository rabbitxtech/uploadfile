// PATCH /api/folders/:id must not move a folder into a TRASHED parent.
//
// POST / already refuses a trashed parent, with the reasoning spelled out in the
// route: a live child inside a trashed folder is listed by neither view. GET
// /api/folders filters `trashedAt: null`, so the dead ancestor is hidden and
// there is no path to browse through it; GET /api/trash lists
// `trashedAt: { not: null }`, so the child itself is not there either. The row
// stays live, still billed, reachable from nowhere in the UI, with no error.
//
// The PATCH route resolved its destination with `{ id, ownerId }` and no
// `trashedAt` filter, so the rule was enforced on create and skipped on move —
// and move is the one the UI drives, via drag-and-drop in the folder tree. A
// folder moved this way takes its whole subtree (and every file under it) out of
// sight in one gesture.
//
// This is the folder twin of the trashed-file write gate, and the mirror of the
// restore-ancestor walk: that walk repairs a live row stranded under a trashed
// ancestor, and this stops one being created on purpose.
//
// Needs a real database: the fix is a where-clause.
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
const { makeUser, login, makeFolder } = await import('../helpers/fixtures.js');
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
  request(app).patch(`/api/folders/${id}`).set('Authorization', auth).send(body);

describe('PATCH /api/folders/:id with a trashed destination', () => {
  it('refuses to move a folder into a trashed parent', async () => {
    const user = await makeUser();
    const { auth } = await login(user);
    const dest = await makeFolder(user, { name: 'dead' });
    const moving = await makeFolder(user, { name: 'keep' });

    await prisma.folder.update({ where: { id: dest.id }, data: { trashedAt: new Date() } });

    const res = await patch(auth, moving.id, { parentId: dest.id });
    expect(res.status).toBe(404);

    // The folder stayed where it was, and stayed reachable.
    const after = await prisma.folder.findUnique({ where: { id: moving.id } });
    expect(after.parentId).toBeNull();
    expect(after.path).toBe('/keep');
    expect(after.trashedAt).toBeNull();
  });

  // fileAccessLevel-style admin widening is not what saves this: an admin may
  // patch any folder, so the trashed filter is the only check in the way.
  it('refuses for an admin moving someone else’s folder into a trashed parent', async () => {
    const owner = await makeUser();
    const admin = await makeUser({ role: 'admin' });
    const { auth } = await login(admin);
    const dest = await makeFolder(owner, { name: 'dead' });
    const moving = await makeFolder(owner, { name: 'keep' });

    await prisma.folder.update({ where: { id: dest.id }, data: { trashedAt: new Date() } });

    const res = await patch(auth, moving.id, { parentId: dest.id });
    expect(res.status).toBe(404);
    expect((await prisma.folder.findUnique({ where: { id: moving.id } })).parentId).toBeNull();
  });

  // The create route's matching rule, pinned alongside so the two stay in step.
  it('still refuses to CREATE a folder under a trashed parent', async () => {
    const user = await makeUser();
    const { auth } = await login(user);
    const dest = await makeFolder(user, { name: 'dead' });
    await prisma.folder.update({ where: { id: dest.id }, data: { trashedAt: new Date() } });

    const res = await request(app)
      .post('/api/folders')
      .set('Authorization', auth)
      .send({ name: 'child', parentId: dest.id });
    expect(res.status).toBe(404);
  });

  // The gate is on the destination only — an ordinary move must still work, and
  // must still rewrite the descendants' denormalised paths.
  it('still moves a folder into a live parent, rewriting descendant paths', async () => {
    const user = await makeUser();
    const { auth } = await login(user);
    const dest = await makeFolder(user, { name: 'dest' });
    const moving = await makeFolder(user, { name: 'keep' });
    const child = await makeFolder(user, { name: 'sub', parentId: moving.id });

    const res = await patch(auth, moving.id, { parentId: dest.id });
    expect(res.status).toBe(200);

    expect((await prisma.folder.findUnique({ where: { id: moving.id } })).path).toBe('/dest/keep');
    expect((await prisma.folder.findUnique({ where: { id: child.id } })).path).toBe(
      '/dest/keep/sub',
    );
  });

  // A rename with no parentId in the body must not start consulting the
  // destination rule at all.
  it('still renames a folder without touching its parent', async () => {
    const user = await makeUser();
    const { auth } = await login(user);
    const folder = await makeFolder(user, { name: 'before' });

    const res = await patch(auth, folder.id, { name: 'after' });
    expect(res.status).toBe(200);
    expect((await prisma.folder.findUnique({ where: { id: folder.id } })).path).toBe('/after');
  });

  // Moving to the root is expressed as parentId: null and must stay allowed.
  it('still moves a folder to the root', async () => {
    const user = await makeUser();
    const { auth } = await login(user);
    const parent = await makeFolder(user, { name: 'parent' });
    const child = await makeFolder(user, { name: 'child', parentId: parent.id });

    const res = await patch(auth, child.id, { parentId: null });
    expect(res.status).toBe(200);

    const after = await prisma.folder.findUnique({ where: { id: child.id } });
    expect(after.parentId).toBeNull();
    expect(after.path).toBe('/child');
  });
});
