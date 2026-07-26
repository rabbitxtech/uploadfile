// A trashed file must not accept new content, against a real database.
//
// `trashedAt` is the source of truth for "in trash", and a trashed file is on
// its way out: the retention sweep and both hard-delete paths refund the SUM of
// its FileVersion rows and remove every version's object. Two write routes
// resolved the file with a bare `ownedWhere()` and so happily wrote to one:
//
//   POST /files/:id/versions  — charges the owner for bytes attached to a row
//                               the user cannot see (the trash view lists
//                               File.size, not the history) and never asked to
//                               keep. If the sweep runs between the charge and
//                               a restore, the file is gone while the bytes
//                               were only just added.
//   POST /files/:id/optimize  — starts a remux plus an HLS/whisper backfill on
//                               a file that is about to be deleted.
//
// Every other content-write path already refuses a trashed target (collab-save
// checks file.trashedAt, upload/init scopes replaceFileId to trashedAt: null,
// the WebDAV PUT overwrite looks the file up with it), so these two were the
// inconsistent ones. Only reachable against a real DB: the gate is a Prisma
// where-clause, so it either filters the row or it doesn't.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';

vi.mock('../../src/services/storage.service.js', () => ({
  objectKeyFor: (userId, ext) => `u/${userId}/${Math.random().toString(36).slice(2)}.${ext}`,
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
  queueIndexFile: vi.fn(async () => {}),
  syncVectorColumn: vi.fn(async () => {}),
}));
vi.mock('../../src/services/thumbnail.service.js', () => ({
  canThumbnail: vi.fn(() => false),
  generateThumbnail: vi.fn(async () => {}),
}));
vi.mock('../../src/services/hls.service.js', () => ({
  removeHls: vi.fn(async () => {}),
  maybeGenerateHls: vi.fn(async () => {}),
}));

// The optimize route is the one place these are actually invoked, so spy on
// them: the fix has to stop the work starting, not merely change the status.
const optimizeFileVideo = vi.fn(async () => {});
vi.mock('../../src/services/video.service.js', () => ({
  canFaststart: vi.fn(() => true),
  optimizeFileVideo: (...a) => optimizeFileVideo(...a),
  canVideoThumbnail: vi.fn(() => false),
  generateVideoThumbnail: vi.fn(async () => null),
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
  optimizeFileVideo.mockClear();
});

afterAll(async () => {
  await disconnect();
});

describe('POST /files/:id/versions on a trashed file', () => {
  it('404s instead of minting a version and charging the owner', async () => {
    const user = await makeUser();
    const { auth } = await login(user);
    const file = await makeFile(user, { name: 'notes.txt', size: 1000 });
    await prisma.file.update({ where: { id: file.id }, data: { trashedAt: new Date() } });
    await prisma.user.update({ where: { id: user.id }, data: { usedBytes: 1000n } });

    const res = await request(app)
      .post(`/api/files/${file.id}/versions`)
      .set('Authorization', auth)
      .attach('file', Buffer.alloc(500, 'x'), 'notes.txt');
    expect(res.status).toBe(404);

    // No version row was added...
    const versions = await prisma.fileVersion.findMany({ where: { fileId: file.id } });
    expect(versions).toHaveLength(1);

    // ...and no bytes were charged for content the user can't reach.
    const after = await prisma.user.findUnique({ where: { id: user.id } });
    expect(after.usedBytes).toBe(1000n);
  });

  it('still accepts a version on a live file', async () => {
    const user = await makeUser();
    const { auth } = await login(user);
    const file = await makeFile(user, { name: 'notes.txt', size: 1000 });
    await prisma.user.update({ where: { id: user.id }, data: { usedBytes: 1000n } });

    const res = await request(app)
      .post(`/api/files/${file.id}/versions`)
      .set('Authorization', auth)
      .attach('file', Buffer.alloc(500, 'x'), 'notes.txt');
    expect(res.status).toBe(201);

    const versions = await prisma.fileVersion.findMany({ where: { fileId: file.id } });
    expect(versions).toHaveLength(2);

    // Each version upload charges separately and leaves the old object behind.
    const after = await prisma.user.findUnique({ where: { id: user.id } });
    expect(after.usedBytes).toBe(1500n);
  });

  it('404s for an admin acting on someone else\'s trashed file', async () => {
    // ownedWhere() drops the ownerId filter for admins, so the trashedAt gate
    // is the only thing standing between an admin and this write.
    const owner = await makeUser();
    const admin = await makeUser({ role: 'admin' });
    const { auth } = await login(admin);
    const file = await makeFile(owner, { name: 'notes.txt', size: 1000 });
    await prisma.file.update({ where: { id: file.id }, data: { trashedAt: new Date() } });

    const res = await request(app)
      .post(`/api/files/${file.id}/versions`)
      .set('Authorization', auth)
      .attach('file', Buffer.alloc(500, 'x'), 'notes.txt');
    expect(res.status).toBe(404);
  });
});

describe('POST /files/:id/optimize on a trashed file', () => {
  it('404s without starting the remux', async () => {
    const user = await makeUser();
    const { auth } = await login(user);
    const file = await makeFile(user, { name: 'clip.mp4', mimeType: 'video/mp4', size: 1000 });
    await prisma.file.update({ where: { id: file.id }, data: { trashedAt: new Date() } });

    const res = await request(app)
      .post(`/api/files/${file.id}/optimize`)
      .set('Authorization', auth);
    expect(res.status).toBe(404);
    expect(optimizeFileVideo).not.toHaveBeenCalled();
  });

  it('still optimizes a live video', async () => {
    const user = await makeUser();
    const { auth } = await login(user);
    const file = await makeFile(user, { name: 'clip.mp4', mimeType: 'video/mp4', size: 1000 });

    const res = await request(app)
      .post(`/api/files/${file.id}/optimize`)
      .set('Authorization', auth);
    expect(res.status).toBe(200);
    expect(optimizeFileVideo).toHaveBeenCalledWith(file.id);
  });
});
