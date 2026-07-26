// Collections must not become a read primitive for other people's files.
//
// A collection is owned by its creator, but its *contents* are an m2m join —
// the only thing asserting a file belongs there. So every place that writes the
// join has to filter by owner, and the read-back has to filter too. Get either
// wrong and GET /:id serves a stranger's file rows as the caller's own, with no
// `select` narrowing them: ocrText (the full extracted document text),
// objectKey, checksum and size all included. That reads as an ordinary
// collection listing, which is why it needs a test rather than a careful eye.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';

vi.mock('../../src/services/ai.service.js', () => ({
  indexFile: vi.fn(async () => {}),
  syncVectorColumn: vi.fn(async () => {}),
}));

const { prisma, migrateTestDb, resetDb, disconnect } = await import('../helpers/db.js');
const { makeUser, login, makeFile } = await import('../helpers/fixtures.js');
const { buildApp } = await import('../../src/app.js');

const app = buildApp();

beforeAll(() => { migrateTestDb(); }, 120_000);
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await disconnect(); });

describe('creating a collection with someone else\'s file ids', () => {
  it('silently drops the ids instead of connecting them', async () => {
    const victim = await makeUser();
    const attacker = await makeUser();
    const { auth } = await login(attacker);
    const secret = await makeFile(victim, { name: 'payroll.pdf' });

    const res = await request(app)
      .post('/api/collections')
      .set('Authorization', auth)
      .send({ name: 'loot', kind: 'manual', fileIds: [secret.id] });
    expect(res.status).toBe(201);

    // The join row must not exist at all — not merely be filtered on read.
    const withFiles = await prisma.collection.findUnique({
      where: { id: res.body.id },
      include: { files: { select: { id: true } } },
    });
    expect(withFiles.files).toEqual([]);
  });

  it('GET /:id does not serve the file even if a join row exists', async () => {
    const victim = await makeUser();
    const attacker = await makeUser();
    const { auth } = await login(attacker);
    const secret = await makeFile(victim, { name: 'payroll.pdf' });

    const collection = await prisma.collection.create({
      data: { name: 'loot', kind: 'manual', ownerId: attacker.id },
    });
    // Force the bad state the route must never produce, so the read-back filter
    // is tested independently of the write-side filter. Belt and braces: either
    // one alone closes the hole, and this asserts we have both.
    await prisma.collection.update({
      where: { id: collection.id },
      data: { files: { connect: { id: secret.id } } },
    });

    const res = await request(app)
      .get(`/api/collections/${collection.id}`)
      .set('Authorization', auth);
    expect(res.status).toBe(200);
    expect(res.body.files).toEqual([]);
  });

  it('still connects the caller\'s own files, and mixed input keeps only those', async () => {
    const victim = await makeUser();
    const owner = await makeUser();
    const { auth } = await login(owner);
    const mine = await makeFile(owner, { name: 'mine.txt' });
    const theirs = await makeFile(victim, { name: 'theirs.txt' });

    const res = await request(app)
      .post('/api/collections')
      .set('Authorization', auth)
      .send({ name: 'mixed', kind: 'manual', fileIds: [mine.id, theirs.id] });
    expect(res.status).toBe(201);

    const got = await request(app)
      .get(`/api/collections/${res.body.id}`)
      .set('Authorization', auth);
    expect(got.body.files.map((f) => f.name)).toEqual(['mine.txt']);
  });

  it('a trashed file of the caller is not connected either', async () => {
    const owner = await makeUser();
    const { auth } = await login(owner);
    const gone = await makeFile(owner, { name: 'gone.txt', trashedAt: new Date() });

    const res = await request(app)
      .post('/api/collections')
      .set('Authorization', auth)
      .send({ name: 'c', kind: 'manual', fileIds: [gone.id] });

    const got = await request(app)
      .get(`/api/collections/${res.body.id}`)
      .set('Authorization', auth);
    expect(got.body.files).toEqual([]);
  });

  it('POST /:id/files rejects a stranger\'s file the same way', async () => {
    const victim = await makeUser();
    const owner = await makeUser();
    const { auth } = await login(owner);
    const secret = await makeFile(victim);

    const created = await request(app)
      .post('/api/collections')
      .set('Authorization', auth)
      .send({ name: 'c', kind: 'manual' });

    const res = await request(app)
      .post(`/api/collections/${created.body.id}/files`)
      .set('Authorization', auth)
      .send({ fileIds: [secret.id] });
    expect(res.status).toBe(200);
    expect(res.body.added).toBe(0);
  });
});
