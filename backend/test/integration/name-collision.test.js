// One name, one resource per (owner, folder) — across BOTH kinds of row.
//
// Two invariants had no enforcement anywhere:
//
//   1. a file and a folder could occupy the same path, and
//   2. two live files could share one name inside one folder.
//
// Both are only observable once real sibling rows exist, so neither is reachable
// from the unit suite. They matter because three layers resolve a name back to a
// row and each assumes the mapping is unique: WebDAV's findFile/findFolder use
// findFirst (row order picks the winner), the PUT overwrite branch looks the name
// up the same way, and PROPFIND emits one <D:href> per row. A folder additionally
// shadows a file outright — PROPFIND answers <D:collection/> and DELETE takes the
// folder branch — leaving the file live, billed against the owner's quota, and
// unreachable over WebDAV entirely. That is the same "live, billed, reachable
// from neither view" state the trashed-parent gates, the restore-ancestor walk
// and assertNoSiblingCollision all exist to prevent.
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
  // Mirror the real signature: uploadPart takes ONE options object and returns
  // the recorded part. Returning {} makes every part report size 0, which is the
  // silent 0-byte-object failure mode CLAUDE.md warns about — and here it would
  // make complete() reject on a short total rather than on the name.
  uploadPart: vi.fn(async ({ partNumber, length }) => ({
    partNumber,
    etag: `etag-${partNumber}`,
    size: length,
  })),
  completeMultipart: vi.fn(async () => ({})),
  abortMultipart: vi.fn(async () => {}),
}));

vi.mock('../../src/services/ai.service.js', () => ({
  indexFile: vi.fn(async () => {}),
  queueIndexFile: vi.fn(async () => {}),
  syncVectorColumn: vi.fn(async () => {}),
  embed: vi.fn(async () => null),
  cosine: () => 0,
}));

const { prisma, migrateTestDb, resetDb, disconnect } = await import('../helpers/db.js');
const { makeUser, makeFolder, makeFile, login } = await import('../helpers/fixtures.js');
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

describe('a folder and a file cannot share one path', () => {
  it('MKCOL refuses a path a live file already holds', async () => {
    const user = await makeUser();
    await makeFile(user, { name: 'report', folderId: null, size: 500n });

    const res = await request(app).mkcol('/webdav/report').set('Authorization', basic(user));

    expect(res.status).toBe(405);
    expect(await prisma.folder.count({ where: { ownerId: user.id, path: '/report' } })).toBe(0);
  });

  it('WebDAV PUT refuses a path a live folder already holds, and charges nothing', async () => {
    const user = await makeUser();
    await makeFolder(user, { name: 'docs' });

    const res = await request(app)
      .put('/webdav/docs')
      .set('Authorization', basic(user))
      .set('Content-Type', 'text/plain')
      .send('important contents');

    expect(res.status).toBe(409);
    // Nothing written, nothing billed: the pre-fix behaviour created a File row,
    // charged the quota and 201'd, and the client could never read it back.
    expect(await prisma.file.count({ where: { ownerId: user.id, name: 'docs' } })).toBe(0);
    const u = await prisma.user.findUnique({ where: { id: user.id } });
    expect(u.usedBytes).toBe(0n);
  });

  it('WebDAV MOVE refuses a folder onto a live file name', async () => {
    const user = await makeUser();
    const src = await makeFolder(user, { name: 'src' });
    await makeFile(user, { name: 'dest', folderId: null });

    const res = await request(app)
      .move('/webdav/src')
      .set('Authorization', basic(user))
      .set('Destination', '/webdav/dest');

    expect(res.status).toBe(412);
    const unchanged = await prisma.folder.findUnique({ where: { id: src.id } });
    expect(unchanged.path).toBe('/src');
  });

  it('WebDAV MOVE refuses a file onto a live folder name', async () => {
    const user = await makeUser();
    await makeFolder(user, { name: 'dest' });
    const file = await makeFile(user, { name: 'src.txt', folderId: null });

    const res = await request(app)
      .move('/webdav/src.txt')
      .set('Authorization', basic(user))
      .set('Destination', '/webdav/dest');

    expect(res.status).toBe(412);
    const unchanged = await prisma.file.findUnique({ where: { id: file.id } });
    expect(unchanged.name).toBe('src.txt');
  });

  it('POST /api/folders refuses the name of a live sibling file', async () => {
    const user = await makeUser();
    const { auth } = await login(user);
    await makeFile(user, { name: 'report', folderId: null });

    const res = await request(app)
      .post('/api/folders')
      .set('Authorization', auth)
      .send({ name: 'report' });

    expect(res.status).toBe(409);
  });

  it('PATCH /api/folders/:id refuses a rename onto a live sibling file name', async () => {
    const user = await makeUser();
    const { auth } = await login(user);
    const folder = await makeFolder(user, { name: 'aaa' });
    await makeFile(user, { name: 'bbb', folderId: null });

    const res = await request(app)
      .patch(`/api/folders/${folder.id}`)
      .set('Authorization', auth)
      .send({ name: 'bbb' });

    expect(res.status).toBe(409);
  });

  it('PATCH /api/files/:id refuses a rename onto a live folder name', async () => {
    const user = await makeUser();
    const { auth } = await login(user);
    await makeFolder(user, { name: 'docs' });
    const file = await makeFile(user, { name: 'x.txt', folderId: null });

    const res = await request(app)
      .patch(`/api/files/${file.id}`)
      .set('Authorization', auth)
      .send({ name: 'docs' });

    expect(res.status).toBe(409);
  });

  it('POST /api/files refuses an upload named after a live folder', async () => {
    const user = await makeUser();
    const { auth } = await login(user);
    await makeFolder(user, { name: 'docs' });

    const res = await request(app)
      .post('/api/files')
      .set('Authorization', auth)
      .attach('file', Buffer.from('hello'), 'docs');

    expect(res.status).toBe(409);
    const u = await prisma.user.findUnique({ where: { id: user.id } });
    expect(u.usedBytes).toBe(0n);
  });

  it('POST /api/upload/init refuses a filename a live folder already holds', async () => {
    const user = await makeUser();
    const { auth } = await login(user);
    await makeFolder(user, { name: 'docs' });

    const res = await request(app)
      .post('/api/upload/init')
      .set('Authorization', auth)
      .send({ filename: 'docs', size: 10, mimeType: 'text/plain' });

    expect(res.status).toBe(409);
  });

  it('the drop-box refuses an anonymous upload named after a subfolder', async () => {
    const owner = await makeUser();
    const box = await makeFolder(owner, { name: 'inbox' });
    await makeFolder(owner, { name: 'photos', parentId: box.id });
    const share = await prisma.share.create({
      data: { token: 'droptoken1', folderId: box.id, ownerId: owner.id, allowUpload: true },
    });

    const res = await request(app)
      .post(`/api/shares/public/${share.token}/upload`)
      .attach('file', Buffer.from('hi'), 'photos');

    expect(res.status).toBe(409);
    const u = await prisma.user.findUnique({ where: { id: owner.id } });
    expect(u.usedBytes).toBe(0n);
  });
});

describe('two live files cannot share one name in one folder', () => {
  it('PATCH /api/files/:id refuses a rename onto a sibling file name', async () => {
    const user = await makeUser();
    const { auth } = await login(user);
    await makeFile(user, { name: 'dup.txt', folderId: null });
    const other = await makeFile(user, { name: 'other.txt', folderId: null });

    const res = await request(app)
      .patch(`/api/files/${other.id}`)
      .set('Authorization', auth)
      .send({ name: 'dup.txt' });

    expect(res.status).toBe(409);
    expect(
      await prisma.file.count({ where: { ownerId: user.id, name: 'dup.txt', trashedAt: null } }),
    ).toBe(1);
  });

  it('bulk rename skips the collision and reports it instead of failing the batch', async () => {
    const user = await makeUser();
    const { auth } = await login(user);
    const a = await makeFile(user, { name: 'a.txt', folderId: null });
    const b = await makeFile(user, { name: 'b.txt', folderId: null });

    const res = await request(app)
      .post('/api/files/bulk/rename')
      .set('Authorization', auth)
      .send({ renames: [{ id: a.id, name: 'merged.txt' }, { id: b.id, name: 'merged.txt' }] });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ count: 1, skipped: 1 });
    expect(
      await prisma.file.count({ where: { ownerId: user.id, name: 'merged.txt', trashedAt: null } }),
    ).toBe(1);
  });

  it('bulk move skips a file whose name is taken in the destination', async () => {
    const user = await makeUser();
    const { auth } = await login(user);
    const dest = await makeFolder(user, { name: 'dest' });
    await makeFile(user, { name: 'clash.txt', folderId: dest.id });
    const clashing = await makeFile(user, { name: 'clash.txt', folderId: null });
    const fine = await makeFile(user, { name: 'fine.txt', folderId: null });

    const res = await request(app)
      .post('/api/files/bulk/move')
      .set('Authorization', auth)
      .send({ ids: [clashing.id, fine.id], folderId: dest.id });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ count: 1, skipped: 1 });
    expect((await prisma.file.findUnique({ where: { id: clashing.id } })).folderId).toBeNull();
    expect((await prisma.file.findUnique({ where: { id: fine.id } })).folderId).toBe(dest.id);
  });

  it('bulk move does not land two same-named files from different folders together', async () => {
    const user = await makeUser();
    const { auth } = await login(user);
    const dest = await makeFolder(user, { name: 'dest' });
    const one = await makeFolder(user, { name: 'one' });
    const two = await makeFolder(user, { name: 'two' });
    const a = await makeFile(user, { name: 'same.txt', folderId: one.id });
    const b = await makeFile(user, { name: 'same.txt', folderId: two.id });

    const res = await request(app)
      .post('/api/files/bulk/move')
      .set('Authorization', auth)
      .send({ ids: [a.id, b.id], folderId: dest.id });

    expect(res.body).toEqual({ count: 1, skipped: 1 });
    expect(
      await prisma.file.count({ where: { folderId: dest.id, name: 'same.txt', trashedAt: null } }),
    ).toBe(1);
  });
});

describe('the rule does not fire where it must not', () => {
  it('a no-op rename, and a tags-only patch, still succeed', async () => {
    const user = await makeUser();
    const { auth } = await login(user);
    const file = await makeFile(user, { name: 'keep.txt', folderId: null });

    const same = await request(app)
      .patch(`/api/files/${file.id}`)
      .set('Authorization', auth)
      .send({ name: 'keep.txt' });
    expect(same.status).toBe(200);

    const tags = await request(app)
      .patch(`/api/files/${file.id}`)
      .set('Authorization', auth)
      .send({ tags: ['todo'] });
    expect(tags.status).toBe(200);
  });

  it('a TRASHED row does not reserve its name', async () => {
    const user = await makeUser();
    const { auth } = await login(user);
    // A trashed file keeps its name but is on its way out and invisible to every
    // listing, so it must not block re-using the name — the same rule
    // assertNoSiblingCollision applies to folders.
    const dead = await makeFile(user, { name: 'gone.txt', folderId: null });
    await prisma.file.update({ where: { id: dead.id }, data: { trashedAt: new Date() } });
    const live = await makeFile(user, { name: 'live.txt', folderId: null });

    const res = await request(app)
      .patch(`/api/files/${live.id}`)
      .set('Authorization', auth)
      .send({ name: 'gone.txt' });

    expect(res.status).toBe(200);
  });

  it('a trashed FOLDER does not block a file taking its name', async () => {
    const user = await makeUser();
    const { auth } = await login(user);
    const folder = await makeFolder(user, { name: 'docs' });
    await prisma.folder.update({ where: { id: folder.id }, data: { trashedAt: new Date() } });

    const res = await request(app)
      .post('/api/files')
      .set('Authorization', auth)
      .attach('file', Buffer.from('hello'), 'docs');

    expect(res.status).toBe(201);
  });

  it('another user owning the name is irrelevant', async () => {
    const mine = await makeUser();
    const theirs = await makeUser();
    const { auth } = await login(mine);
    // Names are scoped per owner: a stranger's folder called "docs" must not stop
    // me uploading a file called "docs", the same reason grantCoversFolder pins
    // its path match to an ownerId.
    await makeFolder(theirs, { name: 'docs' });

    const res = await request(app)
      .post('/api/files')
      .set('Authorization', auth)
      .attach('file', Buffer.from('hello'), 'docs');

    expect(res.status).toBe(201);
  });

  it('two uploads of the same filename still both land — that is product behaviour', async () => {
    const user = await makeUser();
    const { auth } = await login(user);
    // The Uploader detects a duplicate client-side and offers a replace; keeping
    // both is a legitimate choice, and both rows stay visible in the REST
    // listing, so nothing is hidden. Only the file-vs-FOLDER case is refused.
    const first = await request(app)
      .post('/api/files')
      .set('Authorization', auth)
      .attach('file', Buffer.from('one'), 'same.txt');
    const second = await request(app)
      .post('/api/files')
      .set('Authorization', auth)
      .attach('file', Buffer.from('two'), 'same.txt');

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
  });
});

describe('a chunked upload cannot fail at complete() over a name', () => {
  it('renames around a folder that appeared mid-upload instead of stranding the bytes', async () => {
    const user = await makeUser();
    const { auth } = await login(user);

    const init = await request(app)
      .post('/api/upload/init')
      .set('Authorization', auth)
      .send({ filename: 'notes.txt', size: 5, mimeType: 'text/plain' });
    expect(init.status).toBe(201);

    await request(app)
      .put(`/api/upload/${init.body.sessionId}/part?part=1`)
      .set('Authorization', auth)
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.from('hello'));

    // The folder appears while the parts are in flight — init() could not have
    // seen it. The bytes are already in MinIO and paid for, so complete() must
    // not refuse: a client cannot retry into a name it has no way to change.
    await makeFolder(user, { name: 'notes.txt' });

    const done = await request(app)
      .post(`/api/upload/${init.body.sessionId}/complete`)
      .set('Authorization', auth)
      .send({});

    expect(done.status).toBe(201);
    expect(done.body.name).toBe('notes (file).txt');
    expect(done.body.originalName).toBe('notes.txt');
  });
});
