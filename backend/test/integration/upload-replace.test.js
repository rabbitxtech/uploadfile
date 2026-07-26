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

  // A 0-byte file is ordinary (touch a file, export an empty log) and the client
  // sends every upload through this flow — there is no single-shot fallback in
  // Uploader.jsx. The part route rejected an empty body outright, so `complete`
  // was never reached and the upload could not succeed at all. The frontend unit
  // test did not catch it because its fetch stub answers 200 to any part,
  // including the empty one; only driving the real route shows the failure.
  it('accepts a 0-byte file through the chunked flow', async () => {
    const user = await makeUser();
    const { auth } = await login(user);

    const res = await uploadChunked(auth, { filename: 'empty.txt', bytes: 0 });

    expect(res.status).toBe(201);
    expect(res.body.name).toBe('empty.txt');
    expect(String(res.body.size)).toBe('0');
    const after = await prisma.user.findUnique({ where: { id: user.id } });
    expect(after.usedBytes).toBe(0n);
  });

  // The quota is only checked at init (declared size) and at complete (actual
  // bytes). Nothing stopped a client from declaring size:0 and then streaming
  // unlimited parts into MinIO — complete would refuse to create the File row,
  // but the bytes were already stored and the multipart upload was left behind.
  it('refuses a part that pushes the session past the declared size', async () => {
    const user = await makeUser({ quotaBytes: 1000n });
    const { auth } = await login(user);

    const init = await request(app)
      .post('/api/upload/init')
      .set('Authorization', auth)
      .send({ filename: 'liar.txt', size: 10, mimeType: 'text/plain' });
    expect(init.status).toBe(201);

    const part = await request(app)
      .put(`/api/upload/${init.body.sessionId}/part?part=1`)
      .set('Authorization', auth)
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.alloc(5000, 0x41));

    expect(part.status).toBe(413);
  });

  // S3/MinIO cap a multipart upload at 10000 parts. Without an upper bound the
  // route accepted ?part=999999: the quota check passed and the whole body was
  // read before MinIO rejected it deep inside uploadPart — and since complete()
  // requires the numbers to be exactly 1..N, the session could never finish, so
  // its parts sat in MinIO until something aborted it.
  it('rejects a part number beyond the multipart limit', async () => {
    const user = await makeUser({ quotaBytes: 1_000_000n });
    const { auth } = await login(user);

    const init = await request(app)
      .post('/api/upload/init')
      .set('Authorization', auth)
      .send({ filename: 'a.txt', size: 100, mimeType: 'text/plain' });
    expect(init.status).toBe(201);

    for (const part of [10001, 999999]) {
      const res = await request(app)
        .put(`/api/upload/${init.body.sessionId}/part?part=${part}`)
        .set('Authorization', auth)
        .set('Content-Type', 'application/octet-stream')
        .send(Buffer.alloc(10, 0x41));
      expect(res.status).toBe(400);
    }

    // The last legal part number is still accepted.
    const ok = await request(app)
      .put(`/api/upload/${init.body.sessionId}/part?part=10000`)
      .set('Authorization', auth)
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.alloc(10, 0x41));
    expect(ok.status).toBe(200);
  });

  it('refuses a part that would exceed the remaining quota', async () => {
    const user = await makeUser({ quotaBytes: 1000n });
    const { auth } = await login(user);

    // Declared size is within quota, so init passes; the part is not.
    const init = await request(app)
      .post('/api/upload/init')
      .set('Authorization', auth)
      .send({ filename: 'liar.txt', size: 900, mimeType: 'text/plain' });
    expect(init.status).toBe(201);

    const part = await request(app)
      .put(`/api/upload/${init.body.sessionId}/part?part=1`)
      .set('Authorization', auth)
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.alloc(5000, 0x41));

    expect(part.status).toBe(413);
  });

  it('aborts the multipart upload when the assembled size does not match', async () => {
    const { abortMultipart } = await import('../../src/services/storage.service.js');
    abortMultipart.mockClear();

    const user = await makeUser();
    const { auth } = await login(user);

    const init = await request(app)
      .post('/api/upload/init')
      .set('Authorization', auth)
      .send({ filename: 'a.txt', size: 100, mimeType: 'text/plain' });

    // Forge a parts list that claims more bytes than were declared, so complete
    // takes the size-mismatch branch.
    await prisma.uploadSession.update({
      where: { id: init.body.sessionId },
      data: { parts: JSON.stringify([{ partNumber: 1, etag: 'etag-1', size: 99999 }]) },
    });

    const done = await request(app)
      .post(`/api/upload/${init.body.sessionId}/complete`)
      .set('Authorization', auth);

    expect(done.status).toBe(400);
    // The reserved multipart upload must not be left dangling in MinIO.
    expect(abortMultipart).toHaveBeenCalled();
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

  // A replace refunds the old file before charging the new one, so it only ever
  // costs the difference. Checking the gross size instead refuses a same-size
  // replace for anyone near their limit — and, once the part route also checks
  // quota, does it halfway through the transfer with bytes already in MinIO.
  it('allows a same-size replace with no headroom left', async () => {
    const user = await makeUser({ quotaBytes: 1000n });
    const { auth } = await login(user);
    const old = await makeFile(user, { name: 'doc.txt', size: 900 });
    await prisma.user.update({ where: { id: user.id }, data: { usedBytes: 900n } });

    const res = await uploadChunked(auth, {
      filename: 'doc.txt',
      bytes: 900,
      replaceFileId: old.id,
    });

    expect(res.status).toBe(201);
    const after = await prisma.user.findUnique({ where: { id: user.id } });
    expect(after.usedBytes).toBe(900n);
  });

  // The mirror image: the refund is not a blank cheque. Growing past the quota
  // must still be refused even though part of it is covered by the refund.
  it('still refuses a replace whose growth exceeds the quota', async () => {
    const user = await makeUser({ quotaBytes: 1000n });
    const { auth } = await login(user);
    const old = await makeFile(user, { name: 'doc.txt', size: 900 });
    await prisma.user.update({ where: { id: user.id }, data: { usedBytes: 900n } });

    const init = await request(app)
      .post('/api/upload/init')
      .set('Authorization', auth)
      .send({
        filename: 'doc.txt',
        size: 5000,
        mimeType: 'text/plain',
        replaceFileId: old.id,
      });

    expect(init.status).toBe(413);
    const after = await prisma.user.findUnique({ where: { id: user.id } });
    expect(after.usedBytes).toBe(900n); // nothing charged, nothing refunded
  });

  // A file with history occupies the SUM of its versions: each version upload
  // charged the owner separately and left the previous object in MinIO. The
  // replace path used to refund only File.size (the current version), so every
  // older version's bytes stayed on the usage counter forever — the rows went
  // away with the cascade and nothing could ever reconcile the difference.
  it('refunds every version of the replaced file, not just the current one', async () => {
    const user = await makeUser({ quotaBytes: 10_000n });
    const { auth } = await login(user);
    const old = await makeFile(user, { name: 'doc.txt', size: 300 });
    // Two older revisions, as `POST /files/:id/versions` would have left them.
    await prisma.fileVersion.createMany({
      data: [
        { fileId: old.id, version: 2, objectKey: 'u/v2', size: 400n },
        { fileId: old.id, version: 3, objectKey: 'u/v3', size: 500n },
      ],
    });
    // makeFile's version 1 (300) + 400 + 500 = 1200 actually charged.
    await prisma.user.update({ where: { id: user.id }, data: { usedBytes: 1200n } });

    const res = await uploadChunked(auth, {
      filename: 'doc.txt',
      bytes: 100,
      replaceFileId: old.id,
    });

    expect(res.status).toBe(201);
    const after = await prisma.user.findUnique({ where: { id: user.id } });
    // All 1200 refunded, 100 charged — not 1200 - 300 + 100 = 1000.
    expect(after.usedBytes).toBe(100n);
  });

  // The mirror of the refund fix: the quota check at init must also see the
  // full refund, or a replace that clearly fits is refused at the door.
  it('counts every version of the replaced file toward the init quota check', async () => {
    const user = await makeUser({ quotaBytes: 1000n });
    const { auth } = await login(user);
    const old = await makeFile(user, { name: 'doc.txt', size: 300 });
    await prisma.fileVersion.create({
      data: { fileId: old.id, version: 2, objectKey: 'u/v2', size: 600n },
    });
    await prisma.user.update({ where: { id: user.id }, data: { usedBytes: 900n } });

    // Replacing 900 bytes of history with 900 new ones is a wash; counting only
    // the 300-byte current version would make this look like +600 and 413.
    const res = await uploadChunked(auth, {
      filename: 'doc.txt',
      bytes: 900,
      replaceFileId: old.id,
    });

    expect(res.status).toBe(201);
    const after = await prisma.user.findUnique({ where: { id: user.id } });
    expect(after.usedBytes).toBe(900n);
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

// usedBytes is the quota denominator, and every refund path calls subUsage with
// bytes read BEFORE the row was deleted. Two refunds can therefore overlap (the
// retention sweep racing `POST /trash/empty`, or a re-tried delete), and an
// unfloored `decrement` turns that drift into a NEGATIVE usedBytes — which
// reads as effectively unlimited quota, permanently.
describe('quota refunds cannot drive usedBytes negative', () => {
  it('floors usedBytes at zero when more is refunded than was charged', async () => {
    const { subUsage } = await import('../../src/services/quota.service.js');
    const user = await makeUser();
    await prisma.user.update({ where: { id: user.id }, data: { usedBytes: 100n } });

    await subUsage(user.id, 500); // refund larger than the balance

    const after = await prisma.user.findUnique({ where: { id: user.id } });
    expect(after.usedBytes).toBe(0n);
  });

  it('still applies a refund that fits', async () => {
    const { subUsage } = await import('../../src/services/quota.service.js');
    const user = await makeUser();
    await prisma.user.update({ where: { id: user.id }, data: { usedBytes: 500n } });

    await subUsage(user.id, 200);

    const after = await prisma.user.findUnique({ where: { id: user.id } });
    expect(after.usedBytes).toBe(300n);
  });
});

// The per-part size/quota guard must not break resuming: re-sending a part
// replaces it, so the projected total has to exclude the part being overwritten
// rather than adding to it.
describe('per-part limits and resume', () => {
  it('allows re-sending the same part without tripping the size guard', async () => {
    const user = await makeUser({ quotaBytes: 10_000n });
    const { auth } = await login(user);

    const init = await request(app)
      .post('/api/upload/init')
      .set('Authorization', auth)
      .send({ filename: 'r.txt', size: 600, mimeType: 'text/plain' });
    expect(init.status).toBe(201);

    const send = () =>
      request(app)
        .put(`/api/upload/${init.body.sessionId}/part?part=1`)
        .set('Authorization', auth)
        .set('Content-Type', 'application/octet-stream')
        .send(Buffer.alloc(600, 0x41));

    expect((await send()).status).toBe(200);
    expect((await send()).status).toBe(200); // retry, not a second 600 bytes

    const done = await request(app)
      .post(`/api/upload/${init.body.sessionId}/complete`)
      .set('Authorization', auth);
    expect(done.status).toBe(201);

    const after = await prisma.user.findUnique({ where: { id: user.id } });
    expect(after.usedBytes).toBe(600n); // charged once, not twice
  });

  it('accepts a multi-part upload that stays within the declared size', async () => {
    const user = await makeUser({ quotaBytes: 10_000n });
    const { auth } = await login(user);

    const init = await request(app)
      .post('/api/upload/init')
      .set('Authorization', auth)
      .send({ filename: 'm.txt', size: 900, mimeType: 'text/plain' });

    for (const part of [1, 2, 3]) {
      const res = await request(app)
        .put(`/api/upload/${init.body.sessionId}/part?part=${part}`)
        .set('Authorization', auth)
        .set('Content-Type', 'application/octet-stream')
        .send(Buffer.alloc(300, 0x41));
      expect(res.status).toBe(200);
    }

    const done = await request(app)
      .post(`/api/upload/${init.body.sessionId}/complete`)
      .set('Authorization', auth);
    expect(done.status).toBe(201);

    const after = await prisma.user.findUnique({ where: { id: user.id } });
    expect(after.usedBytes).toBe(900n);
  });
});

describe('chunked upload → incomplete uploads are refused, not silently truncated', () => {
  // complete() only bounded the total from ABOVE, so an upload missing a part
  // passed: the numbers 1,2,4 total less than the declared size, and
  // completeMultipart assembles whichever pieces exist. That produced a File
  // whose recorded size matched the stored bytes but whose content had a hole —
  // no error anywhere, the user just finds a file that will not open.
  it('rejects a gap in the part numbers', async () => {
    const user = await makeUser();
    const { auth } = await login(user);

    const init = await request(app)
      .post('/api/upload/init')
      .set('Authorization', auth)
      .send({ filename: 'gap.txt', size: 1200, mimeType: 'text/plain' });
    expect(init.status).toBe(201);

    // Parts 1, 2 and 4 — part 3 is never sent.
    for (const part of [1, 2, 4]) {
      const res = await request(app)
        .put(`/api/upload/${init.body.sessionId}/part?part=${part}`)
        .set('Authorization', auth)
        .set('Content-Type', 'application/octet-stream')
        .send(Buffer.alloc(300, 0x41));
      expect(res.status).toBe(200);
    }

    const done = await request(app)
      .post(`/api/upload/${init.body.sessionId}/complete`)
      .set('Authorization', auth);

    expect(done.status).toBe(400);
    expect(done.body.error ?? done.body.message ?? '').toMatch(/incomplete|missing/i);

    // Nothing was created and nothing was charged.
    expect(await prisma.file.count({ where: { ownerId: user.id } })).toBe(0);
    const after = await prisma.user.findUnique({ where: { id: user.id } });
    expect(after.usedBytes).toBe(0n);
  });

  it('rejects a total that falls short of the declared size', async () => {
    const user = await makeUser();
    const { auth } = await login(user);

    const init = await request(app)
      .post('/api/upload/init')
      .set('Authorization', auth)
      .send({ filename: 'short.txt', size: 5000, mimeType: 'text/plain' });
    expect(init.status).toBe(201);

    // A single small part: contiguous, but nowhere near the declared 5000.
    await request(app)
      .put(`/api/upload/${init.body.sessionId}/part?part=1`)
      .set('Authorization', auth)
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.alloc(100, 0x41));

    const done = await request(app)
      .post(`/api/upload/${init.body.sessionId}/complete`)
      .set('Authorization', auth);

    expect(done.status).toBe(400);
    expect(await prisma.file.count({ where: { ownerId: user.id } })).toBe(0);
  });

  // The happy path must stay unaffected by the completeness checks: a final
  // part shorter than the others is normal (the file rarely divides evenly).
  it('still accepts a correct upload whose last part is short', async () => {
    const user = await makeUser();
    const { auth } = await login(user);

    const init = await request(app)
      .post('/api/upload/init')
      .set('Authorization', auth)
      .send({ filename: 'ragged.txt', size: 700, mimeType: 'text/plain' });

    for (const [part, len] of [[1, 300], [2, 300], [3, 100]]) {
      const res = await request(app)
        .put(`/api/upload/${init.body.sessionId}/part?part=${part}`)
        .set('Authorization', auth)
        .set('Content-Type', 'application/octet-stream')
        .send(Buffer.alloc(len, 0x41));
      expect(res.status).toBe(200);
    }

    const done = await request(app)
      .post(`/api/upload/${init.body.sessionId}/complete`)
      .set('Authorization', auth);
    expect(done.status).toBe(201);

    const after = await prisma.user.findUnique({ where: { id: user.id } });
    expect(after.usedBytes).toBe(700n);
  });

  // Parts are recorded by rewriting a JSON *string* column, so a plain
  // read-modify-write loses an entry when two PUTs overlap — and a lost part is
  // exactly the silent truncation the checks above now catch. The write is
  // guarded by a compare-and-set on the previous value, so concurrent parts
  // either serialise or retry; none may vanish.
  it('does not lose parts when they are uploaded concurrently', async () => {
    const user = await makeUser();
    const { auth } = await login(user);

    const init = await request(app)
      .post('/api/upload/init')
      .set('Authorization', auth)
      .send({ filename: 'parallel.txt', size: 1200, mimeType: 'text/plain' });
    expect(init.status).toBe(201);

    const results = await Promise.all(
      [1, 2, 3, 4].map((part) =>
        request(app)
          .put(`/api/upload/${init.body.sessionId}/part?part=${part}`)
          .set('Authorization', auth)
          .set('Content-Type', 'application/octet-stream')
          .send(Buffer.alloc(300, 0x41)),
      ),
    );
    for (const r of results) expect(r.status).toBe(200);

    const session = await prisma.uploadSession.findUnique({
      where: { id: init.body.sessionId },
    });
    const stored = JSON.parse(session.parts)
      .map((p) => p.partNumber)
      .sort((a, b) => a - b);
    expect(stored).toEqual([1, 2, 3, 4]);

    const done = await request(app)
      .post(`/api/upload/${init.body.sessionId}/complete`)
      .set('Authorization', auth);
    expect(done.status).toBe(201);

    const after = await prisma.user.findUnique({ where: { id: user.id } });
    expect(after.usedBytes).toBe(1200n);
  });
});
