// POST /api/files/reindex — admin-only, and the backfill is serialised.
//
// The README, the routing map and the OpenAPI spec all describe this route as
// admin-only; the role check was simply missing. It only ever queues the
// CALLER's own files, so it was never a privilege-escalation hole — it is a
// resource one: each queued file shells out to tesseract (plus pdftoppm for a
// PDF) and then runs a transformers.js embedding, so one call can start up to
// 1000 CPU-heavy jobs, and the loop lived in the request handler so repeated
// calls stacked their own loops instead of sharing a queue.
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

// Which files the route handed to the indexer. The queue's own serialisation is
// covered against the real module in test/ai-queue.test.js — here we only care
// that the route enqueues the right set through the right entry point.
const indexed = [];
vi.mock('../../src/services/ai.service.js', () => ({
  indexFile: vi.fn(async () => {}),
  syncVectorColumn: vi.fn(async () => {}),
  embed: vi.fn(async () => null),
  cosine: vi.fn(() => 0),
  queueIndexFile: vi.fn(async (id) => {
    indexed.push(id);
  }),
}));

const { migrateTestDb, resetDb, disconnect } = await import('../helpers/db.js');
const { makeUser, login, makeFile } = await import('../helpers/fixtures.js');
const { buildApp } = await import('../../src/app.js');

const app = buildApp();

beforeAll(() => {
  migrateTestDb();
}, 120_000);

beforeEach(async () => {
  await resetDb();
  indexed.length = 0;
  vi.clearAllMocks(); // call counts are asserted per test
});

afterAll(async () => {
  await disconnect();
});

describe('POST /api/files/reindex', () => {
  it('refuses an ordinary user', async () => {
    const user = await makeUser();
    const { auth } = await login(user);
    await makeFile(user, { name: 'a.txt' });

    const res = await request(app).post('/api/files/reindex').set('Authorization', auth).send({});
    expect(res.status).toBe(403);
    expect(indexed).toEqual([]);
  });

  it('lets an admin queue their own un-indexed files', async () => {
    const admin = await makeUser({ role: 'admin' });
    const { auth } = await login(admin);
    const one = await makeFile(admin, { name: 'a.txt' });
    const two = await makeFile(admin, { name: 'b.txt' });

    const res = await request(app).post('/api/files/reindex').set('Authorization', auth).send({});
    expect(res.status).toBe(200);
    expect(res.body.queued).toBe(2);
    expect(indexed.sort()).toEqual([one.id, two.id].sort());
  });

  it('skips files that already carry an embedding, and trashed ones', async () => {
    const admin = await makeUser({ role: 'admin' });
    const { auth } = await login(admin);
    const fresh = await makeFile(admin, { name: 'fresh.txt' });
    await makeFile(admin, { name: 'done.txt', embedding: JSON.stringify([0.1, 0.2]) });
    await makeFile(admin, { name: 'gone.txt', trashedAt: new Date() });

    const res = await request(app).post('/api/files/reindex').set('Authorization', auth).send({});
    expect(res.body.queued).toBe(1);
    expect(indexed).toEqual([fresh.id]);
  });

  it('routes the backfill through the shared queue helper, not a bare loop', async () => {
    // The route must hand each file to queueIndexFile (the serialised entry
    // point) rather than calling indexFile directly — that is what stops two
    // overlapping calls forking a tesseract per file. The queue itself is
    // covered by the unit test in test/ai-queue.test.js against the real module.
    const ai = await import('../../src/services/ai.service.js');
    const admin = await makeUser({ role: 'admin' });
    const { auth } = await login(admin);
    await makeFile(admin, { name: 'a.txt' });

    await request(app).post('/api/files/reindex').set('Authorization', auth).send({});
    expect(ai.queueIndexFile).toHaveBeenCalledTimes(1);
    expect(ai.indexFile).not.toHaveBeenCalled();
  });
});
