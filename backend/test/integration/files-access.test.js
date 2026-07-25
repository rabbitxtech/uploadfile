// Access-control behaviour of files.routes.js against a real database.
//
// This file exists to make the planned split of files.routes.js (1370 lines)
// safe: it pins WHO can reach WHAT before the routes move. Ownership and the
// admin carve-out are enforced by hand at each route, so a route landing in
// the wrong module — or quietly losing its ownership filter — is exactly the
// regression this catches.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';

vi.mock('../../src/services/storage.service.js', () => ({
  objectKeyFor: (userId, ext) => `u/${userId}/x.${ext}`,
  initiateMultipart: vi.fn(async () => 'up-1'),
  uploadPart: vi.fn(async ({ partNumber, length }) => ({
    partNumber, etag: `e${partNumber}`, size: length ?? 0,
  })),
  completeMultipart: vi.fn(async () => ({})),
  abortMultipart: vi.fn(async () => {}),
  putObjectStream: vi.fn(async () => {}),
  putObjectBuffer: vi.fn(async () => {}),
  getObjectStream: vi.fn(async () => null),
  getObjectRange: vi.fn(async () => null),
  removeObject: vi.fn(async () => {}),
  statObject: vi.fn(async () => ({ size: 0 })),
  removePrefix: vi.fn(async () => {}),
  presignedGet: vi.fn(async () => 'http://minio.test/o'),
}));
vi.mock('../../src/services/media.service.js', () => ({
  postProcessMedia: vi.fn(async () => {}),
}));
vi.mock('../../src/services/ai.service.js', () => ({
  indexFile: vi.fn(async () => {}),
  syncVectorColumn: vi.fn(async () => {}),
}));
vi.mock('../../src/services/thumbnail.service.js', () => ({
  canThumbnail: vi.fn(() => false),
  generateThumbnail: vi.fn(async () => {}),
}));
vi.mock('../../src/services/checksum.service.js', () => ({
  sha: vi.fn(() => 'sum'),
  backfillChecksum: vi.fn(async () => {}),
}));

const { prisma, migrateTestDb, resetDb, disconnect } = await import('../helpers/db.js');
const { makeUser, login, makeFile, makeFolder } = await import('../helpers/fixtures.js');
const { buildApp } = await import('../../src/app.js');

const app = buildApp();

beforeAll(() => { migrateTestDb(); }, 120_000);
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await disconnect(); });

describe('reading another user\'s file', () => {
  it('a stranger gets 404, not 403 — existence is not disclosed', async () => {
    const owner = await makeUser();
    const stranger = await makeUser();
    const { auth } = await login(stranger);
    const file = await makeFile(owner);

    const res = await request(app).get(`/api/files/${file.id}`).set('Authorization', auth);
    expect(res.status).toBe(404);
  });

  it('the owner can read it', async () => {
    const owner = await makeUser();
    const { auth } = await login(owner);
    const file = await makeFile(owner, { name: 'mine.txt' });

    const res = await request(app).get(`/api/files/${file.id}`).set('Authorization', auth);
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('mine.txt');
  });

  it('an admin can read anyone\'s file (read-only carve-out)', async () => {
    const owner = await makeUser();
    const admin = await makeUser({ role: 'admin' });
    const { auth } = await login(admin);
    const file = await makeFile(owner, { name: 'theirs.txt' });

    const res = await request(app).get(`/api/files/${file.id}`).set('Authorization', auth);
    expect(res.status).toBe(200);
  });
});

describe('writing to another user\'s file', () => {
  // NOTE: admins CAN write to any file. `ownedWhere()` drops the ownerId
  // filter for admins and fileAccessLevel() returns 'admin', by explicit
  // design ("admins act on ANY file/folder" — files.routes.js).
  //
  // .claude/CLAUDE.md claimed the opposite ("write routes keep strict
  // ownership", "admin view-as-user is read-only by design"); the doc was
  // wrong and has been corrected. These tests pin the ACTUAL behaviour so the
  // route split cannot change it silently — if admin writes should ever be
  // removed, that is a deliberate change and these tests are where it starts.
  it('an admin can rename someone else\'s file', async () => {
    const owner = await makeUser();
    const admin = await makeUser({ role: 'admin' });
    const { auth } = await login(admin);
    const file = await makeFile(owner, { name: 'orig.txt' });

    const res = await request(app)
      .patch(`/api/files/${file.id}`)
      .set('Authorization', auth)
      .send({ name: 'renamed.txt' });

    expect(res.status).toBe(200);
    const after = await prisma.file.findUnique({ where: { id: file.id } });
    expect(after.name).toBe('renamed.txt');
    expect(after.ownerId).toBe(owner.id); // ownership itself never transfers
  });

  it('an admin can trash someone else\'s file', async () => {
    const owner = await makeUser();
    const admin = await makeUser({ role: 'admin' });
    const { auth } = await login(admin);
    const file = await makeFile(owner);

    const res = await request(app).delete(`/api/files/${file.id}`).set('Authorization', auth);

    expect(res.status).toBe(200);
    const after = await prisma.file.findUnique({ where: { id: file.id } });
    expect(after.trashedAt).not.toBeNull();
  });

  it('a stranger cannot trash a file', async () => {
    const owner = await makeUser();
    const stranger = await makeUser();
    const { auth } = await login(stranger);
    const file = await makeFile(owner);

    await request(app).delete(`/api/files/${file.id}`).set('Authorization', auth);

    const after = await prisma.file.findUnique({ where: { id: file.id } });
    expect(after.trashedAt).toBeNull();
  });

  it('the owner can rename and trash their own file', async () => {
    const owner = await makeUser();
    const { auth } = await login(owner);
    const file = await makeFile(owner, { name: 'a.txt' });

    const renamed = await request(app)
      .patch(`/api/files/${file.id}`)
      .set('Authorization', auth)
      .send({ name: 'b.txt' });
    expect(renamed.status).toBe(200);

    const trashed = await request(app)
      .delete(`/api/files/${file.id}`)
      .set('Authorization', auth);
    expect(trashed.status).toBe(200);

    const after = await prisma.file.findUnique({ where: { id: file.id } });
    expect(after.name).toBe('b.txt');
    expect(after.trashedAt).not.toBeNull();
  });
});

describe('trashed files are filtered out of listings', () => {
  it('recent excludes trashed files', async () => {
    const user = await makeUser();
    const { auth } = await login(user);
    await makeFile(user, { name: 'live.txt', starred: true });
    const gone = await makeFile(user, { name: 'gone.txt', trashedAt: new Date() });
    // accessedAt drives /recent
    await prisma.file.updateMany({ data: { accessedAt: new Date() } });

    const res = await request(app).get('/api/files/recent').set('Authorization', auth);

    expect(res.status).toBe(200);
    expect(res.body.files.map((f) => f.id)).not.toContain(gone.id);
  });

  it('starred excludes trashed files', async () => {
    const user = await makeUser();
    const { auth } = await login(user);
    const live = await makeFile(user, { starred: true });
    const gone = await makeFile(user, { starred: true, trashedAt: new Date() });

    const res = await request(app).get('/api/files/starred').set('Authorization', auth);

    const ids = res.body.files.map((f) => f.id);
    expect(ids).toContain(live.id);
    expect(ids).not.toContain(gone.id);
  });

  it('another user\'s starred files never appear in yours', async () => {
    const me = await makeUser();
    const them = await makeUser();
    const { auth } = await login(me);
    const theirs = await makeFile(them, { starred: true });

    const res = await request(app).get('/api/files/starred').set('Authorization', auth);

    expect(res.body.files.map((f) => f.id)).not.toContain(theirs.id);
  });
});

describe('star toggle', () => {
  it('flips the flag for the owner and rejects a stranger', async () => {
    const owner = await makeUser();
    const stranger = await makeUser();
    const { auth: ownerAuth } = await login(owner);
    const { auth: strangerAuth } = await login(stranger);
    const file = await makeFile(owner, { starred: false });

    const ok = await request(app)
      .post(`/api/files/${file.id}/star`)
      .set('Authorization', ownerAuth);
    expect(ok.status).toBe(200);
    expect((await prisma.file.findUnique({ where: { id: file.id } })).starred).toBe(true);

    await request(app).post(`/api/files/${file.id}/star`).set('Authorization', strangerAuth);
    // Unchanged by the stranger's attempt.
    expect((await prisma.file.findUnique({ where: { id: file.id } })).starred).toBe(true);
  });
});

describe('session revocation cuts API access', () => {
  it('a revoked session is rejected even though the JWT is still valid', async () => {
    const user = await makeUser();
    const { auth, session } = await login(user);
    const file = await makeFile(user);

    const before = await request(app).get(`/api/files/${file.id}`).set('Authorization', auth);
    expect(before.status).toBe(200);

    await prisma.session.update({
      where: { id: session.id },
      data: { revokedAt: new Date() },
    });

    const after = await request(app).get(`/api/files/${file.id}`).set('Authorization', auth);
    expect(after.status).toBe(401);
  });

  it('a banned user is rejected', async () => {
    const user = await makeUser();
    const { auth } = await login(user);
    await prisma.user.update({ where: { id: user.id }, data: { banned: true } });

    const res = await request(app).get('/api/files/starred').set('Authorization', auth);
    expect(res.status).toBe(403);
  });
});

describe('upload gating', () => {
  it('an unapproved user cannot start an upload', async () => {
    const user = await makeUser({ approved: false });
    const { auth } = await login(user);

    const res = await request(app)
      .post('/api/upload/init')
      .set('Authorization', auth)
      .send({ filename: 'a.txt', size: 10, mimeType: 'text/plain' });

    expect(res.status).toBe(403);
  });

  it('an unapproved admin can (admins always pass)', async () => {
    const admin = await makeUser({ role: 'admin', approved: false });
    const { auth } = await login(admin);

    const res = await request(app)
      .post('/api/upload/init')
      .set('Authorization', auth)
      .send({ filename: 'a.txt', size: 10, mimeType: 'text/plain' });

    expect(res.status).toBe(201);
  });
});

describe('folder listing', () => {
  it('does not leak another user\'s folders', async () => {
    const me = await makeUser();
    const them = await makeUser();
    const { auth } = await login(me);
    const mine = await makeFolder(me, { name: 'mine' });
    await makeFolder(them, { name: 'theirs' });

    const res = await request(app).get('/api/folders').set('Authorization', auth);

    expect(res.status).toBe(200);
    const names = res.body.folders.map((f) => f.name);
    expect(names).toContain('mine');
    expect(names).not.toContain('theirs');
    expect(res.body.folders.every((f) => f.ownerId === me.id || f.id === mine.id)).toBe(true);
  });

  it('excludes trashed files from a folder listing', async () => {
    const user = await makeUser();
    const { auth } = await login(user);
    const folder = await makeFolder(user);
    const live = await makeFile(user, { folderId: folder.id });
    const gone = await makeFile(user, { folderId: folder.id, trashedAt: new Date() });

    const res = await request(app)
      .get(`/api/folders?parentId=${folder.id}`)
      .set('Authorization', auth);

    const ids = res.body.files.map((f) => f.id);
    expect(ids).toContain(live.id);
    expect(ids).not.toContain(gone.id);
    expect(res.body.total).toBe(1);
  });
});
