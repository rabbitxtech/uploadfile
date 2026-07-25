// Integration coverage for the replace-on-duplicate flow, against a real
// database. This path moves quota in both directions and deletes rows, so a
// mistake here either loses a file or corrupts the user's usage counter — and
// none of it is reachable from the unit suite.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';

// MinIO is stubbed: this suite is about the database and quota bookkeeping, not
// object transfer. Part sizes are supplied by the test through the raw body.
vi.mock('../../src/services/storage.service.js', () => ({
  objectKeyFor: (userId, ext) => `u/${userId}/${Math.random().toString(36).slice(2)}.${ext}`,
  initiateMultipart: vi.fn(async () => 'test-upload-id'),
  // Real signature is uploadPart({ key, uploadId, partNumber, body, length })
  // — a single options object. Getting this wrong makes every part report
  // size 0, which is exactly the silent-corruption failure mode this suite
  // exists to catch, so mirror it precisely.
  uploadPart: vi.fn(async ({ partNumber, body, length }) => ({
    partNumber,
    etag: `etag-${partNumber}`,
    size: length ?? body?.length ?? 0,
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
  presignedGet: vi.fn(async () => 'http://minio.test/object'),
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
  sha: vi.fn(() => 'test-checksum'),
  backfillChecksum: vi.fn(async () => {}),
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

/** Drives init → part → complete, returning the completed response. */
async function uploadChunked(auth, { filename, bytes, replaceFileId = null }) {
  const init = await request(app)
    .post('/api/upload/init')
    .set('Authorization', auth)
    .send({ filename, size: bytes, mimeType: 'text/plain', replaceFileId });
  expect(init.status).toBe(201);

  await request(app)
    .put(`/api/upload/${init.body.sessionId}/part?part=1`)
    .set('Authorization', auth)
    .set('Content-Type', 'application/octet-stream')
    .send(Buffer.alloc(bytes, 0x41));

  return request(app)
    .post(`/api/upload/${init.body.sessionId}/complete`)
    .set('Authorization', auth);
}

describe('chunked upload → quota accounting', () => {
  it('charges the uploaded bytes to the owner', async () => {
    const user = await makeUser();
    const { auth } = await login(user);

    const res = await uploadChunked(auth, { filename: 'a.txt', bytes: 500 });

    expect(res.status).toBe(201);
    const after = await prisma.user.findUnique({ where: { id: user.id } });
    expect(after.usedBytes).toBe(500n);
  });

  it('refuses an upload that would exceed the quota', async () => {
    const user = await makeUser({ quotaBytes: 1000n });
    const { auth } = await login(user);

    const init = await request(app)
      .post('/api/upload/init')
      .set('Authorization', auth)
      .send({ filename: 'big.txt', size: 5000, mimeType: 'text/plain' });

    expect(init.status).toBe(413);
    const after = await prisma.user.findUnique({ where: { id: user.id } });
    expect(after.usedBytes).toBe(0n); // nothing charged for a rejected upload
  });

  it('rejects an upload session belonging to another user', async () => {
    const owner = await makeUser();
    const other = await makeUser();
    const { auth: ownerAuth } = await login(owner);
    const { auth: otherAuth } = await login(other);

    const init = await request(app)
      .post('/api/upload/init')
      .set('Authorization', ownerAuth)
      .send({ filename: 'a.txt', size: 10, mimeType: 'text/plain' });

    const stolen = await request(app)
      .post(`/api/upload/${init.body.sessionId}/complete`)
      .set('Authorization', otherAuth);

    expect(stolen.status).toBe(404);
  });

  it('refuses to complete a session twice', async () => {
    const user = await makeUser();
    const { auth } = await login(user);

    const init = await request(app)
      .post('/api/upload/init')
      .set('Authorization', auth)
      .send({ filename: 'a.txt', size: 100, mimeType: 'text/plain' });
    await request(app)
      .put(`/api/upload/${init.body.sessionId}/part?part=1`)
      .set('Authorization', auth)
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.alloc(100, 0x41));

    const first = await request(app)
      .post(`/api/upload/${init.body.sessionId}/complete`)
      .set('Authorization', auth);
    const second = await request(app)
      .post(`/api/upload/${init.body.sessionId}/complete`)
      .set('Authorization', auth);

    expect(first.status).toBe(201);
    expect(second.status).toBe(400);
    // The double-complete must not double-charge the quota.
    const after = await prisma.user.findUnique({ where: { id: user.id } });
    expect(after.usedBytes).toBe(100n);
  });
});

describe('replace-on-duplicate', () => {
  it('deletes the old row, refunds its bytes and charges the new ones', async () => {
    const user = await makeUser();
    const { auth } = await login(user);
    const old = await makeFile(user, { name: 'doc.txt', size: 800 });
    await prisma.user.update({ where: { id: user.id }, data: { usedBytes: 800n } });

    const res = await uploadChunked(auth, {
      filename: 'doc.txt',
      bytes: 300,
      replaceFileId: old.id,
    });

    expect(res.status).toBe(201);
    expect(await prisma.file.findUnique({ where: { id: old.id } })).toBeNull();
    const after = await prisma.user.findUnique({ where: { id: user.id } });
    // 800 refunded, 300 charged — not 1100.
    expect(after.usedBytes).toBe(300n);
  });

  it('rejects replacing a file owned by someone else', async () => {
    const user = await makeUser();
    const victim = await makeUser();
    const { auth } = await login(user);
    const theirs = await makeFile(victim, { name: 'secret.txt', size: 100 });

    const init = await request(app)
      .post('/api/upload/init')
      .set('Authorization', auth)
      .send({
        filename: 'secret.txt',
        size: 10,
        mimeType: 'text/plain',
        replaceFileId: theirs.id,
      });

    expect(init.status).toBe(404);
    // The victim's file must still be there.
    expect(await prisma.file.findUnique({ where: { id: theirs.id } })).not.toBeNull();
  });

  it('rejects replacing a trashed file', async () => {
    const user = await makeUser();
    const { auth } = await login(user);
    const trashed = await makeFile(user, { name: 'gone.txt', trashedAt: new Date() });

    const init = await request(app)
      .post('/api/upload/init')
      .set('Authorization', auth)
      .send({
        filename: 'gone.txt',
        size: 10,
        mimeType: 'text/plain',
        replaceFileId: trashed.id,
      });

    expect(init.status).toBe(404);
  });

  it('still creates the new file when the replaced row vanished mid-flight', async () => {
    // The row is validated at init and re-read at complete; if it disappears in
    // between (a concurrent trash+purge), the upload must still land rather
    // than 500 and strand the bytes already in MinIO.
    const user = await makeUser();
    const { auth } = await login(user);
    const old = await makeFile(user, { name: 'race.txt', size: 400 });
    await prisma.user.update({ where: { id: user.id }, data: { usedBytes: 400n } });

    const init = await request(app)
      .post('/api/upload/init')
      .set('Authorization', auth)
      .send({
        filename: 'race.txt',
        size: 100,
        mimeType: 'text/plain',
        replaceFileId: old.id,
      });
    await request(app)
      .put(`/api/upload/${init.body.sessionId}/part?part=1`)
      .set('Authorization', auth)
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.alloc(100, 0x41));

    await prisma.file.delete({ where: { id: old.id } }); // vanishes

    const res = await request(app)
      .post(`/api/upload/${init.body.sessionId}/complete`)
      .set('Authorization', auth);

    expect(res.status).toBe(201);
    const after = await prisma.user.findUnique({ where: { id: user.id } });
    // No refund happens (nothing to refund), only the new bytes are charged.
    expect(after.usedBytes).toBe(500n);
  });
});
