// POST /api/upload/:id/complete must run exactly once per session.
//
// The route read `s.completed`, then did the whole of the work — the MinIO
// assembly, the quota reservation, the File row — and only marked the session
// completed at the very end. That is a read-modify-write on the flag whose
// entire job is to make the operation once-only, and the window is the full
// duration of a large upload's finalisation.
//
// Measured against a real database before the fix: three concurrent completes on
// ONE session all returned 201, created THREE File rows out of one set of parts,
// and charged the owner 3000 bytes for a 1000-byte upload. It needs no attacker
// — the client retries complete() on a timeout or a dropped connection, which is
// precisely when the first call is still running, and every retry mints another
// duplicate row and another permanent quota charge that no refund path will ever
// reconcile (the duplicates share one objectKey, so deleting either removes the
// object out from under the other).
//
// The fix claims the session with a conditional UPDATE gated on
// `completed: false` before any work starts — the same compare-and-set this
// codebase already applies to UploadSession.parts and User.recoveryCodes, and
// for the same reason: a JSON/flag column that can only be rewritten wholesale
// cannot be read and written as two statements.
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
  uploadPart: vi.fn(async () => ({})),
  completeMultipart: vi.fn(async () => ({})),
  abortMultipart: vi.fn(async () => {}),
}));

vi.mock('../../src/services/ai.service.js', () => ({
  indexFile: vi.fn(async () => {}),
  syncVectorColumn: vi.fn(async () => {}),
}));

vi.mock('../../src/services/checksum.service.js', () => ({
  sha256Buffer: () => 'deadbeef',
  backfillChecksum: vi.fn(async () => {}),
}));

vi.mock('../../src/services/media.service.js', () => ({
  postProcessMedia: vi.fn(async () => {}),
}));

const { prisma, migrateTestDb, resetDb, disconnect } = await import('../helpers/db.js');
const { makeUser, login } = await import('../helpers/fixtures.js');
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

/** A session with one recorded part, ready to be completed. */
async function seedSession(user, { size = 1000n, filename = 'race.bin', folderId = null } = {}) {
  return prisma.uploadSession.create({
    data: {
      ownerId: user.id,
      filename,
      size,
      mimeType: 'application/octet-stream',
      folderId,
      uploadId: 'test-upload-id',
      objectKey: `u/${user.id}/${filename}`,
      parts: JSON.stringify([{ partNumber: 1, etag: 'e1', size: Number(size) }]),
    },
  });
}

describe('POST /upload/:id/complete — runs once per session', () => {
  it('creates ONE file and charges ONE upload under concurrent completes', async () => {
    const user = await makeUser({ quotaBytes: 1_000_000n });
    const { auth } = await login(user);
    const session = await seedSession(user);

    const fire = () =>
      request(app).post(`/api/upload/${session.id}/complete`).set('Authorization', auth).send({});
    const results = await Promise.all([fire(), fire(), fire()]);

    // Exactly one winner; the losers are refused like any finished session.
    const statuses = results.map((r) => r.status).sort();
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 400)).toHaveLength(2);

    const files = await prisma.file.findMany({ where: { ownerId: user.id } });
    expect(files).toHaveLength(1);
    expect(files[0].size).toBe(1000n);

    // ...and the quota reflects one upload, not three. This is the part that
    // could not be undone before: the duplicate rows shared one objectKey, so
    // deleting either removed the object the other still pointed at.
    const owner = await prisma.user.findUnique({ where: { id: user.id } });
    expect(owner.usedBytes).toBe(1000n);
  });

  it('creates ONE version row, so later refunds cannot double-count', async () => {
    // Every hard-delete path refunds the SUM of a file's FileVersion rows, so a
    // duplicated complete was also duplicated refund surface.
    const user = await makeUser({ quotaBytes: 1_000_000n });
    const { auth } = await login(user);
    const session = await seedSession(user, { filename: 'once.bin' });

    const fire = () =>
      request(app).post(`/api/upload/${session.id}/complete`).set('Authorization', auth).send({});
    await Promise.all([fire(), fire()]);

    const versions = await prisma.fileVersion.findMany({});
    expect(versions).toHaveLength(1);
    expect(versions[0].version).toBe(1);
  });

  it('still refuses a second complete after a successful one', async () => {
    const user = await makeUser({ quotaBytes: 1_000_000n });
    const { auth } = await login(user);
    const session = await seedSession(user, { filename: 'serial.bin' });

    await request(app)
      .post(`/api/upload/${session.id}/complete`)
      .set('Authorization', auth)
      .send({})
      .expect(201);

    await request(app)
      .post(`/api/upload/${session.id}/complete`)
      .set('Authorization', auth)
      .send({})
      .expect(400);

    const files = await prisma.file.findMany({ where: { ownerId: user.id } });
    expect(files).toHaveLength(1);
  });

  it('leaves the session completed when it refuses an incomplete upload', async () => {
    // A failed complete must still close the session: failSession aborts the
    // multipart upload, so a retry against the dead uploadId would otherwise
    // hit NoSuchUpload.
    const user = await makeUser({ quotaBytes: 1_000_000n });
    const { auth } = await login(user);
    // Declared 100_000, only 100 uploaded. The shortfall has to exceed
    // PART_SIZE_SLACK (1 KiB, the tolerance complete() allows for the last
    // part), or this is a legitimately-sized upload rather than a truncated one.
    const session = await prisma.uploadSession.create({
      data: {
        ownerId: user.id,
        filename: 'short.bin',
        size: 100_000n,
        mimeType: 'application/octet-stream',
        uploadId: 'test-upload-id',
        objectKey: `u/${user.id}/short.bin`,
        parts: JSON.stringify([{ partNumber: 1, etag: 'e1', size: 100 }]),
      },
    });

    await request(app)
      .post(`/api/upload/${session.id}/complete`)
      .set('Authorization', auth)
      .send({})
      .expect(400);

    const after = await prisma.uploadSession.findUnique({ where: { id: session.id } });
    expect(after.completed).toBe(true);

    // Nothing was created and nothing was charged.
    const files = await prisma.file.findMany({ where: { ownerId: user.id } });
    expect(files).toHaveLength(0);
    const owner = await prisma.user.findUnique({ where: { id: user.id } });
    expect(owner.usedBytes).toBe(0n);
  });
});
