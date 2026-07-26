// Integration coverage for the WebDAV PUT overwrite path, against a real
// database.
//
// This route is the one place that rewrites a file in place instead of adding a
// revision, so it has to reconcile two things the rest of the app keeps
// separate: the object(s) in MinIO and the owner's byte counter. Both the quota
// check and the refund have to agree on what a file with history actually
// occupies (the SUM of its versions, not File.size) — and neither is reachable
// from the unit suite, because both only misbehave once real version rows exist.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';

const removed = [];

vi.mock('../../src/services/storage.service.js', () => ({
  objectKeyFor: (userId, ext) => `u/${userId}/${Math.random().toString(36).slice(2)}.${ext}`,
  putObjectStream: vi.fn(async () => {}),
  putObjectBuffer: vi.fn(async () => {}),
  getObjectStream: vi.fn(async () => null),
  getObjectRange: vi.fn(async () => null),
  removeObject: vi.fn(async (key) => {
    removed.push(key);
  }),
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
const { makeUser } = await import('../helpers/fixtures.js');
const { buildApp } = await import('../../src/app.js');

const app = buildApp();

beforeAll(() => {
  migrateTestDb();
}, 120_000);

beforeEach(async () => {
  await resetDb();
  removed.length = 0;
});

afterAll(async () => {
  await disconnect();
});

const basic = (user) =>
  'Basic ' + Buffer.from(`${user.email}:${user.password}`).toString('base64');

/** A file carrying real version history, as a versions upload would leave it. */
async function makeVersionedFile(owner, { name, sizes }) {
  const keyFor = (i) => `u/${owner.id}/v${i}-${Math.random().toString(36).slice(2)}`;
  const file = await prisma.file.create({
    data: {
      name,
      originalName: name,
      mimeType: 'text/plain',
      size: BigInt(sizes[sizes.length - 1]),
      objectKey: keyFor(sizes.length),
      bucket: process.env.MINIO_BUCKET || 'uploads',
      ownerId: owner.id,
      currentVersion: sizes.length,
      versions: {
        create: sizes.map((s, i) => ({
          version: i + 1,
          objectKey: keyFor(i + 1),
          size: BigInt(s),
        })),
      },
    },
    include: { versions: true },
  });
  // The current version must point at the file's live object, as production has it.
  await prisma.fileVersion.updateMany({
    where: { fileId: file.id, version: sizes.length },
    data: { objectKey: file.objectKey },
  });
  const total = sizes.reduce((n, s) => n + BigInt(s), 0n);
  await prisma.user.update({
    where: { id: owner.id },
    data: { usedBytes: total },
  });
  return { file, total };
}

describe('WebDAV PUT overwrite', () => {
  it('refunds every version of the overwritten file, not just the current one', async () => {
    const user = await makeUser();
    // 3 versions totalling 3000 bytes; File.size is only the current 1000.
    const { file } = await makeVersionedFile(user, { name: 'notes.txt', sizes: [1000, 1000, 1000] });

    const body = Buffer.alloc(500, 'x');
    const res = await request(app)
      .put('/webdav/notes.txt')
      .set('Authorization', basic(user))
      .set('Content-Type', 'text/plain')
      .send(body);
    expect(res.status).toBe(204);

    // The file now occupies exactly the new bytes. Refunding File.size (1000)
    // instead of the version sum (3000) would leave usedBytes at 2500.
    const after = await prisma.user.findUnique({ where: { id: user.id } });
    expect(after.usedBytes).toBe(500n);

    // and the stale version rows are gone rather than pointing at deleted objects
    const versions = await prisma.fileVersion.findMany({ where: { fileId: file.id } });
    expect(versions).toHaveLength(1);
    expect(versions[0].size).toBe(500n);

    const updated = await prisma.file.findUnique({ where: { id: file.id } });
    expect(versions[0].objectKey).toBe(updated.objectKey);
  });

  it('removes the objects of every version it dropped', async () => {
    const user = await makeUser();
    const { file } = await makeVersionedFile(user, { name: 'doc.txt', sizes: [10, 20, 30] });
    const before = await prisma.fileVersion.findMany({ where: { fileId: file.id } });
    const oldKeys = new Set(before.map((v) => v.objectKey));

    const res = await request(app)
      .put('/webdav/doc.txt')
      .set('Authorization', basic(user))
      .set('Content-Type', 'text/plain')
      .send(Buffer.alloc(5, 'y'));
    expect(res.status).toBe(204);

    // Every superseded object is deleted; leaving them behind is a silent leak
    // that no later delete path can find, since the rows are gone.
    for (const k of oldKeys) expect(removed).toContain(k);

    // ...and never the object that was just written.
    const updated = await prisma.file.findUnique({ where: { id: file.id } });
    expect(removed).not.toContain(updated.objectKey);
  });

  it('allows an overwrite that fits once the old versions are accounted for', async () => {
    // Quota is exactly the current usage: nothing more can be added, but
    // replacing 3000 bytes of history with 900 plainly fits. Checking
    // `size - File.size` (900 - 1000) happened to pass here by going negative;
    // checking the gross size would 507. Only the version-aware net cost is right.
    const user = await makeUser({ quotaBytes: 3000n });
    await makeVersionedFile(user, { name: 'big.txt', sizes: [1000, 1000, 1000] });

    const res = await request(app)
      .put('/webdav/big.txt')
      .set('Authorization', basic(user))
      .set('Content-Type', 'text/plain')
      .send(Buffer.alloc(900, 'z'));
    expect(res.status).toBe(204);

    const after = await prisma.user.findUnique({ where: { id: user.id } });
    expect(after.usedBytes).toBe(900n);
  });

  it('still refuses an overwrite that genuinely exceeds the quota', async () => {
    // The net-cost check must not become a blanket exemption for overwrites:
    // 5000 new bytes against 3000 refunded is 2000 owed, over the 3500 cap.
    const user = await makeUser({ quotaBytes: 3500n });
    await makeVersionedFile(user, { name: 'big.txt', sizes: [1000, 1000, 1000] });

    const res = await request(app)
      .put('/webdav/big.txt')
      .set('Authorization', basic(user))
      .set('Content-Type', 'text/plain')
      .send(Buffer.alloc(5000, 'z'));
    expect(res.status).toBe(507);

    // and the rejected write changed nothing
    const after = await prisma.user.findUnique({ where: { id: user.id } });
    expect(after.usedBytes).toBe(3000n);
  });

  it('charges a first-time PUT the full size', async () => {
    const user = await makeUser();
    const res = await request(app)
      .put('/webdav/fresh.txt')
      .set('Authorization', basic(user))
      .set('Content-Type', 'text/plain')
      .send(Buffer.alloc(700, 'a'));
    expect(res.status).toBe(201);

    const after = await prisma.user.findUnique({ where: { id: user.id } });
    expect(after.usedBytes).toBe(700n);

    // A fresh PUT must create the version-1 row every other upload path creates.
    const file = await prisma.file.findFirst({
      where: { ownerId: user.id, name: 'fresh.txt' },
      include: { versions: true },
    });
    expect(file.versions).toHaveLength(1);
    expect(file.versions[0].size).toBe(700n);
    expect(file.versions[0].objectKey).toBe(file.objectKey);
  });
});
