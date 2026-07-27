// A quota must hold under CONCURRENT uploads, not just sequential ones.
//
// `assertQuota` reads usedBytes and `addUsage` writes it, and every upload path
// runs them as two statements with the entire upload in between. That is a
// read-modify-write on the counter that IS the limit: concurrent requests all
// read the same pre-upload balance, all conclude they fit, and all commit. The
// quota is then exceeded by roughly however many uploads were in flight.
//
// This needs no attacker to reach — browsers upload several files in parallel by
// default, and `Uploader.jsx` does exactly that. The anonymous drop-box
// (POST /shares/public/:token/upload) reaches the same path with NO credentials,
// so a stranger holding an upload link can push an owner arbitrarily far past
// their limit; storage is the resource the quota exists to bound.
//
// The fix is `reserveQuota`: one conditional UPDATE that increments only if the
// result still fits, which the database serialises per row. These cases pin
// both directions — the limit must hold under concurrency, AND a legitimate
// upload that fits must still succeed (a check that simply refuses everything
// would also "pass" the first assertion).
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';

vi.mock('../../src/services/storage.service.js', () => ({
  objectKeyFor: (userId, ext) => `u/${userId}/${Math.random().toString(36).slice(2)}.${ext}`,
  putObjectStream: vi.fn(async () => {}),
  putObjectBuffer: vi.fn(async () => {}),
  getObjectStream: vi.fn(async () => null),
  getObjectRange: vi.fn(async () => null),
  removeObject: vi.fn(async () => {}),
  removePrefix: vi.fn(async () => {}),
  statObject: vi.fn(async () => ({ size: 0 })),
  presignedGet: vi.fn(async () => 'http://minio.test/o'),
  initiateMultipart: vi.fn(async () => 'up-1'),
  uploadPart: vi.fn(async ({ partNumber, length }) => ({
    partNumber, etag: `e${partNumber}`, size: length ?? 0,
  })),
  completeMultipart: vi.fn(async () => ({})),
  abortMultipart: vi.fn(async () => {}),
}));
vi.mock('../../src/services/hls.service.js', () => ({
  removeHls: vi.fn(async () => {}),
  maybeGenerateHls: vi.fn(async () => {}),
  hlsPrefix: (id) => `h/${id}/`,
}));
vi.mock('../../src/services/ai.service.js', () => ({
  indexFile: vi.fn(async () => {}),
  queueIndexFile: vi.fn(async () => {}),
  syncVectorColumn: vi.fn(async () => {}),
}));
vi.mock('../../src/services/media.service.js', () => ({
  postProcessMedia: vi.fn(() => {}),
}));

const { prisma, migrateTestDb, resetDb, disconnect } = await import('../helpers/db.js');
const { makeUser, login, makeFolder } = await import('../helpers/fixtures.js');
const { buildApp } = await import('../../src/app.js');

const app = buildApp();

beforeAll(() => { migrateTestDb(); }, 120_000);
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await disconnect(); });

const QUOTA = 1000n;
const CHUNK = 200; // 5 of these exactly fill the quota
const N = 10;      // ...so 10 in flight must not all succeed

async function usedBytes(userId) {
  const u = await prisma.user.findUnique({ where: { id: userId } });
  return BigInt(u.usedBytes);
}

describe('quota holds under concurrency — single-shot upload', () => {
  it('never lets concurrent uploads exceed the quota', async () => {
    const u = await makeUser({ quotaBytes: QUOTA });
    const { auth } = await login(u);
    const body = Buffer.alloc(CHUNK, 'x');

    const statuses = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        request(app).post('/api/files').set('Authorization', auth)
          .attach('file', body, `f${i}.bin`).then((r) => r.status)),
    );

    const used = await usedBytes(u.id);
    expect(used).toBeLessThanOrEqual(QUOTA);
    // The bytes actually stored must equal what the counter says.
    const files = await prisma.file.findMany({ where: { ownerId: u.id } });
    const stored = files.reduce((n, f) => n + BigInt(f.size), 0n);
    expect(stored).toBeLessThanOrEqual(QUOTA);
    expect(statuses.filter((s) => s === 201).length).toBe(Number(QUOTA) / CHUNK);
  });

  it('still accepts uploads that genuinely fit (not simply refusing everything)', async () => {
    const u = await makeUser({ quotaBytes: QUOTA });
    const { auth } = await login(u);
    const r = await request(app).post('/api/files').set('Authorization', auth)
      .attach('file', Buffer.alloc(CHUNK, 'x'), 'ok.bin');
    expect(r.status).toBe(201);
    expect(await usedBytes(u.id)).toBe(BigInt(CHUNK));
  });

  it('refuses a single upload larger than the whole quota', async () => {
    const u = await makeUser({ quotaBytes: QUOTA });
    const { auth } = await login(u);
    const r = await request(app).post('/api/files').set('Authorization', auth)
      .attach('file', Buffer.alloc(Number(QUOTA) + 1, 'x'), 'big.bin');
    expect(r.status).toBe(413);
    expect(await usedBytes(u.id)).toBe(0n);
  });
});

describe('quota holds under concurrency — anonymous drop-box', () => {
  it('a stranger with an upload link cannot push the owner past their quota', async () => {
    const u = await makeUser({ quotaBytes: QUOTA });
    const { auth } = await login(u);
    const folder = await makeFolder(u, { name: 'dropbox' });
    const share = await request(app).post('/api/shares').set('Authorization', auth)
      .send({ folderId: folder.id, allowUpload: true });
    const token = share.body.token;
    const body = Buffer.alloc(CHUNK, 'x');

    // No Authorization header anywhere below — this is the anonymous path.
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        request(app).post(`/api/shares/public/${token}/upload`)
          .attach('file', body, `d${i}.bin`).then((r) => r.status)),
    );

    const used = await usedBytes(u.id);
    expect(used).toBeLessThanOrEqual(QUOTA);
    const files = await prisma.file.findMany({ where: { ownerId: u.id } });
    const stored = files.reduce((n, f) => n + BigInt(f.size), 0n);
    expect(stored).toBeLessThanOrEqual(QUOTA);
  });

  it('the drop-box still accepts an upload that fits', async () => {
    const u = await makeUser({ quotaBytes: QUOTA });
    const { auth } = await login(u);
    const folder = await makeFolder(u, { name: 'dropbox2' });
    const share = await request(app).post('/api/shares').set('Authorization', auth)
      .send({ folderId: folder.id, allowUpload: true });
    const r = await request(app).post(`/api/shares/public/${share.body.token}/upload`)
      .attach('file', Buffer.alloc(CHUNK, 'x'), 'fits.bin');
    expect(r.status).toBe(201);
    expect(await usedBytes(u.id)).toBe(BigInt(CHUNK));
  });
});

describe('quota holds under concurrency — chunked upload', () => {
  // The chunked flow charges at complete(), which read usedBytes and then wrote
  // it as two statements just like the single-shot path. Sessions are set up
  // sequentially so only the COMPLETE calls race — that is the window under test.
  async function initAndFill(auth, i) {
    const init = await request(app).post('/api/upload/init').set('Authorization', auth)
      .send({ filename: `c${i}.bin`, size: CHUNK, mimeType: 'application/octet-stream' });
    await request(app).put(`/api/upload/${init.body.sessionId}/part?part=1`)
      .set('Authorization', auth)
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.alloc(CHUNK, 'x'));
    return init.body.sessionId;
  }

  it('never lets concurrent completes exceed the quota', async () => {
    const u = await makeUser({ quotaBytes: QUOTA });
    const { auth } = await login(u);
    const sessions = [];
    for (let i = 0; i < N; i += 1) sessions.push(await initAndFill(auth, i));

    await Promise.all(sessions.map((id) =>
      request(app).post(`/api/upload/${id}/complete`).set('Authorization', auth)
        .then((r) => r.status)));

    expect(await usedBytes(u.id)).toBeLessThanOrEqual(QUOTA);
    const files = await prisma.file.findMany({ where: { ownerId: u.id } });
    const stored = files.reduce((n, f) => n + BigInt(f.size), 0n);
    expect(stored).toBeLessThanOrEqual(QUOTA);
  });

  it('a chunked upload that fits still completes', async () => {
    const u = await makeUser({ quotaBytes: QUOTA });
    const { auth } = await login(u);
    const id = await initAndFill(auth, 0);
    const r = await request(app).post(`/api/upload/${id}/complete`).set('Authorization', auth);
    expect(r.status).toBe(201);
    expect(await usedBytes(u.id)).toBe(BigInt(CHUNK));
  });
});

describe('reserveQuota — the primitive', () => {
  it('reserves atomically and refuses once the balance is committed', async () => {
    const { reserveQuota } = await import('../../src/services/quota.service.js');
    const u = await makeUser({ quotaBytes: QUOTA });

    const results = await Promise.allSettled(
      Array.from({ length: N }, () => reserveQuota(u.id, CHUNK)),
    );
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    expect(ok).toBe(Number(QUOTA) / CHUNK);
    expect(await usedBytes(u.id)).toBe(QUOTA);
  });

  it('a released reservation frees the bytes again', async () => {
    const { reserveQuota, releaseQuota } = await import('../../src/services/quota.service.js');
    const u = await makeUser({ quotaBytes: QUOTA });
    await reserveQuota(u.id, CHUNK);
    expect(await usedBytes(u.id)).toBe(BigInt(CHUNK));
    await releaseQuota(u.id, CHUNK);
    expect(await usedBytes(u.id)).toBe(0n);
  });
});
