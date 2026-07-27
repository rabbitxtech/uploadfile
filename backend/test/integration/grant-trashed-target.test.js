// A grant cannot be WRITTEN against a trashed file or folder.
//
// Trashing is this codebase's "un-share it" action, and every read surface
// already enforces it: a public link 404s once its target is trashed
// (assertShareTargetLive), `fileAccessLevel`/`folderAccessLevel` return null for
// a grantee on a trashed row, and GET /api/grants/shared-with-me filters trashed
// rows out of the listing. POST /api/grants was the one place that still created
// a grant against one.
//
// The grant is not harmless while the item sits in the trash — it is a row that
// activates the moment the item is RESTORED. Restoring is ordinary housekeeping
// ("I deleted that by mistake"), and nothing about it suggests it also hands out
// access the owner never granted while the file was visible. The Trash page has
// a restore button and no mention of sharing, so the owner has no prompt to go
// re-check the file's grants afterwards.
//
// The folder case reaches further than the file case: folderAccessLevel matches
// a grant down the whole subtree by path prefix, so one grant written against a
// trashed folder becomes access to everything under it on restore.
//
// An ADMIN can reach any user's file here (the ownership check passes for
// role 'admin'), so this is also the path by which a third party gains standing
// access to a file whose owner believes they deleted it.
//
// Needs a real database: this is a where-clause/branch change, so the row is
// either created or refused.
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
  presignedGet: vi.fn(async () => 'http://minio.test/SIGNED'),
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

describe('POST /api/grants refuses a trashed target', () => {
  it('refuses a file the owner has trashed', async () => {
    const owner = await makeUser();
    const grantee = await makeUser();
    const { auth } = await login(owner);
    const file = await makeFile(owner, { name: 'deleted.txt', trashedAt: new Date() });

    const res = await request(app)
      .post('/api/grants')
      .set('Authorization', auth)
      .send({ fileId: file.id, identifier: grantee.email, permission: 'view' });

    expect(res.status).toBe(404);
    expect(await prisma.fileGrant.count({ where: { fileId: file.id } })).toBe(0);
  });

  it('refuses a folder the owner has trashed', async () => {
    const owner = await makeUser();
    const grantee = await makeUser();
    const { auth } = await login(owner);
    const folder = await makeFolder(owner, { name: 'deleted-folder' });
    await prisma.folder.update({ where: { id: folder.id }, data: { trashedAt: new Date() } });

    const res = await request(app)
      .post('/api/grants')
      .set('Authorization', auth)
      .send({ folderId: folder.id, identifier: grantee.email, permission: 'view' });

    expect(res.status).toBe(404);
    expect(await prisma.folderGrant.count({ where: { folderId: folder.id } })).toBe(0);
  });

  it('still allows a grant on a LIVE file — the gate must not break sharing', async () => {
    const owner = await makeUser();
    const grantee = await makeUser();
    const { auth } = await login(owner);
    const file = await makeFile(owner, { name: 'live.txt' });

    const res = await request(app)
      .post('/api/grants')
      .set('Authorization', auth)
      .send({ fileId: file.id, identifier: grantee.email, permission: 'view' });

    expect(res.status).toBe(201);
    expect(await prisma.fileGrant.count({ where: { fileId: file.id } })).toBe(1);
  });

  it('refuses a group grant on a trashed file as well', async () => {
    // Group grants resolve through the same access helper, so the same rule has
    // to apply on the write side or the group path re-opens what the user path
    // just closed.
    const owner = await makeUser();
    const member = await makeUser();
    const { auth } = await login(owner);
    const group = await prisma.group.create({ data: { name: `team-${Date.now()}` } });
    await prisma.groupMember.create({ data: { groupId: group.id, userId: member.id } });
    const file = await makeFile(owner, { name: 'team-deleted.txt', trashedAt: new Date() });

    const res = await request(app)
      .post('/api/grants')
      .set('Authorization', auth)
      .send({ fileId: file.id, groupId: group.id, permission: 'view' });

    expect(res.status).toBe(404);
    expect(await prisma.fileGrant.count({ where: { fileId: file.id } })).toBe(0);
  });

  it('refuses an ADMIN granting access to another user’s trashed file', async () => {
    // The ownership check passes for an admin, so without the liveness gate this
    // is the path by which a third party gets standing access to a file its
    // owner believes is deleted — and it activates silently on restore.
    const admin = await makeUser({ role: 'admin' });
    const owner = await makeUser();
    const outsider = await makeUser();
    const { auth } = await login(admin);
    const file = await makeFile(owner, { name: 'owner-deleted.txt', trashedAt: new Date() });

    const res = await request(app)
      .post('/api/grants')
      .set('Authorization', auth)
      .send({ fileId: file.id, identifier: outsider.email, permission: 'edit' });

    expect(res.status).toBe(404);
    expect(await prisma.fileGrant.count({ where: { fileId: file.id } })).toBe(0);
  });

  it('means a restore cannot resurrect access the owner never granted while live', async () => {
    // The end-to-end shape of the bug: grant while trashed → restore → grantee
    // reads the file. With the gate in place the grant never exists, so the
    // restore gives back exactly what the owner had before deleting it.
    const owner = await makeUser();
    const grantee = await makeUser();
    const ownerAuth = (await login(owner)).auth;
    const granteeAuth = (await login(grantee)).auth;
    const file = await makeFile(owner, { name: 'roundtrip.txt', trashedAt: new Date() });

    await request(app)
      .post('/api/grants')
      .set('Authorization', ownerAuth)
      .send({ fileId: file.id, identifier: grantee.email, permission: 'view' });

    await request(app)
      .post('/api/trash/restore')
      .set('Authorization', ownerAuth)
      .send({ fileIds: [file.id] });

    // The file is live again for its owner...
    const asOwner = await request(app).get(`/api/files/${file.id}`).set('Authorization', ownerAuth);
    expect(asOwner.status).toBe(200);

    // ...and still private.
    const asGrantee = await request(app)
      .get(`/api/files/${file.id}`)
      .set('Authorization', granteeAuth);
    expect(asGrantee.status).toBe(404);
  });
});
