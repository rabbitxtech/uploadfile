// A public share link's per-link CAPS must hold under concurrency.
//
// Two caps, one shape of bug in both:
//
//   1. `Share.maxDownloads` — `authorizeShare` read `downloads` at the top of the
//      request and the increment ran when the response stream ENDED (detached,
//      `.catch`-swallowed). The window between the two is the whole download, so
//      every request arriving inside it read the same pre-increment count and was
//      let through. Measured against this suite before the fix: a link capped at
//      1 served 5 of 5 concurrent downloads, and the ZIP branch 4 of 4 — while
//      the counter recorded FEWER than were served, so the owner's own access log
//      understated it too.
//
//   2. the drop-box's `DROPBOX_MAX_UPLOADS_PER_SHARE` — counted `ShareAccess`
//      rows, then wrote one fire-and-forget AFTER the file was created. Same
//      window, and this endpoint takes NO authentication at all, so the cap is
//      the only bound on how many files a stranger holding the link can push into
//      the owner's storage. A link capped at 2 with 1 slot already used accepted
//      6 of 6 concurrent uploads.
//
// Both are now claimed atomically before any bytes move — the same
// compare-and-set `reserveQuota` and the upload `complete()` claim use.
//
// The sequential cases are CONTROLS: they pass either way, and their job is to
// prove the cap itself (and the refusal it produces) still works, so a failure in
// the concurrent cases is really about the race and not about a broken limit.
//
// Needs a real database — a mocked Prisma cannot exhibit a lost update.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { Readable } from 'node:stream';

vi.mock('../../src/services/storage.service.js', () => ({
  objectKeyFor: (u, e) => `u/${u}/${Math.random().toString(36).slice(2)}.${e}`,
  putObjectStream: vi.fn(async () => {}),
  putObjectBuffer: vi.fn(async () => {}),
  // A stream that takes a moment, like a real transfer: this is what opens the
  // check-then-act window the concurrent cases exercise.
  getObjectStream: vi.fn(
    async () =>
      new Readable({
        read() {
          setTimeout(() => {
            this.push(Buffer.from('hello'));
            this.push(null);
          }, 80);
        },
      }),
  ),
  getObjectRange: vi.fn(async () => null),
  removeObject: vi.fn(async () => {}),
  statObject: vi.fn(async () => ({ size: 5 })),
  removePrefix: vi.fn(async () => {}),
  presignedGet: vi.fn(async () => 'http://minio.test/object'),
}));
vi.mock('../../src/services/ai.service.js', () => ({
  indexFile: vi.fn(async () => {}),
  queueIndexFile: vi.fn(async () => {}),
  syncVectorColumn: vi.fn(async () => {}),
}));
vi.mock('../../src/services/thumbnail.service.js', () => ({
  canThumbnail: () => false,
  generateThumbnail: vi.fn(async () => null),
}));
vi.mock('../../src/services/video.service.js', () => ({
  canVideoThumbnail: () => false,
  generateVideoThumbnail: vi.fn(async () => null),
  canFaststart: () => false,
  optimizeFileVideo: vi.fn(async () => {}),
}));

const { prisma, migrateTestDb, resetDb, disconnect } = await import('../helpers/db.js');
const { makeUser, makeFile, makeFolder } = await import('../helpers/fixtures.js');
const { buildApp } = await import('../../src/app.js');
const { env } = await import('../../src/config/env.js');

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

const download = (token) => request(app).post(`/api/shares/public/${token}/download`).send({});

describe('public share download cap', () => {
  it('serves at most maxDownloads when requests arrive together (file share)', async () => {
    const user = await makeUser();
    const file = await makeFile(user, { name: 'secret.txt', size: 5n });
    const share = await prisma.share.create({
      data: { token: 'cap-file-1', fileId: file.id, ownerId: user.id, maxDownloads: 1 },
    });

    const results = await Promise.all(Array.from({ length: 5 }, () => download(share.token)));
    const served = results.filter((r) => r.status === 200).length;
    const refused = results.filter((r) => r.status === 403).length;

    expect(served).toBe(1);
    expect(refused).toBe(4);
  });

  it('serves at most maxDownloads when requests arrive together (folder ZIP share)', async () => {
    const user = await makeUser();
    const folder = await makeFolder(user, { name: 'shared' });
    await makeFile(user, { name: 'a.txt', folderId: folder.id, size: 5n });
    const share = await prisma.share.create({
      data: { token: 'cap-zip-1', folderId: folder.id, ownerId: user.id, maxDownloads: 1 },
    });

    const results = await Promise.all(Array.from({ length: 4 }, () => download(share.token)));
    expect(results.filter((r) => r.status === 200).length).toBe(1);
  });

  it('honours a cap above 1 exactly', async () => {
    const user = await makeUser();
    const file = await makeFile(user, { name: 'b.txt', size: 5n });
    const share = await prisma.share.create({
      data: { token: 'cap-file-3', fileId: file.id, ownerId: user.id, maxDownloads: 3 },
    });

    const results = await Promise.all(Array.from({ length: 8 }, () => download(share.token)));
    expect(results.filter((r) => r.status === 200).length).toBe(3);
  });

  it('records exactly as many downloads as it served', async () => {
    const user = await makeUser();
    const file = await makeFile(user, { name: 'c.txt', size: 5n });
    const share = await prisma.share.create({
      data: { token: 'cap-file-4', fileId: file.id, ownerId: user.id, maxDownloads: 2 },
    });

    const results = await Promise.all(Array.from({ length: 6 }, () => download(share.token)));
    const served = results.filter((r) => r.status === 200).length;
    const after = await prisma.share.findUnique({ where: { id: share.id } });
    // The counter is what the owner sees on the Shares page; it must not
    // understate what actually left the server.
    expect(after.downloads).toBe(served);
  });

  // CONTROL — passes with or without the fix. Proves the cap and its 403 work at
  // all, so the failures above are about the race, not a broken limit.
  it('CONTROL: sequential downloads stop at the cap', async () => {
    const user = await makeUser();
    const file = await makeFile(user, { name: 'd.txt', size: 5n });
    const share = await prisma.share.create({
      data: { token: 'cap-seq', fileId: file.id, ownerId: user.id, maxDownloads: 1 },
    });

    const first = await download(share.token);
    await new Promise((r) => setTimeout(r, 250));
    const second = await download(share.token);

    expect(first.status).toBe(200);
    expect(second.status).toBe(403);
  });

  // CONTROL — an uncapped link is unaffected by any of this.
  it('CONTROL: an uncapped link serves every request', async () => {
    const user = await makeUser();
    const file = await makeFile(user, { name: 'e.txt', size: 5n });
    const share = await prisma.share.create({
      data: { token: 'cap-none', fileId: file.id, ownerId: user.id },
    });

    const results = await Promise.all(Array.from({ length: 4 }, () => download(share.token)));
    expect(results.every((r) => r.status === 200)).toBe(true);
  });
});

describe('drop-box upload cap', () => {
  const dropUpload = (token, name) =>
    request(app)
      .post(`/api/shares/public/${token}/upload`)
      .attach('file', Buffer.from('x'.repeat(10)), name);

  it('accepts at most the cap when uploads arrive together', async () => {
    const cap = env.limits.dropboxMaxUploadsPerShare;
    // The suite runs with whatever cap the env sets, so pre-charge the counter to
    // leave exactly `room` slots and keep the assertion independent of it.
    const room = 2;
    const user = await makeUser();
    const folder = await makeFolder(user, { name: 'drop' });
    const share = await prisma.share.create({
      data: {
        token: 'drop-cap',
        folderId: folder.id,
        ownerId: user.id,
        allowUpload: true,
        uploads: cap - room,
      },
    });

    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) => dropUpload(share.token, `f${i}.txt`)),
    );
    const created = results.filter((r) => r.status === 201).length;
    expect(created).toBe(room);
    expect(await prisma.file.count({ where: { folderId: folder.id } })).toBe(room);
    // And the counter agrees with what was actually stored.
    const after = await prisma.share.findUnique({ where: { id: share.id } });
    expect(after.uploads).toBe(cap);
  });

  it('does not burn a slot on an upload that is refused', async () => {
    const user = await makeUser();
    const folder = await makeFolder(user, { name: 'drop2' });
    const share = await prisma.share.create({
      data: { token: 'drop-refuse', folderId: folder.id, ownerId: user.id, allowUpload: true },
    });
    // A live SUBFOLDER named "taken.txt" makes an upload of that name 409.
    await makeFolder(user, { name: 'taken.txt', parentId: folder.id });

    const refused = await dropUpload(share.token, 'taken.txt');
    expect(refused.status).toBe(409);
    // The rejected attempt must not have consumed one of the link's uploads —
    // otherwise a link can be exhausted by requests that stored nothing.
    const after = await prisma.share.findUnique({ where: { id: share.id } });
    expect(after.uploads).toBe(0);
  });

  // CONTROL — one upload through the happy path still records exactly one use.
  it('CONTROL: a successful upload consumes exactly one slot', async () => {
    const user = await makeUser();
    const folder = await makeFolder(user, { name: 'drop3' });
    const share = await prisma.share.create({
      data: { token: 'drop-one', folderId: folder.id, ownerId: user.id, allowUpload: true },
    });

    const ok = await dropUpload(share.token, 'one.txt');
    expect(ok.status).toBe(201);
    // The COUNTER is what the cap is enforced against, so it must be exact the
    // moment the response is sent.
    const after = await prisma.share.findUnique({ where: { id: share.id } });
    expect(after.uploads).toBe(1);

    // The owner-facing access log records it too — but `logShareAccess` is
    // deliberately fire-and-forget (a bookkeeping write must never fail an
    // upload), so poll for it rather than assuming it has landed by the time the
    // response returns. Asserting it immediately is a race in the TEST, not a
    // defect: under full-suite load the insert can still be in flight.
    let logged = 0;
    for (let i = 0; i < 20 && logged === 0; i += 1) {
      logged = await prisma.shareAccess.count({
        where: { shareId: share.id, action: 'upload' },
      });
      if (!logged) await new Promise((r) => setTimeout(r, 50));
    }
    expect(logged).toBe(1);
  });
});
