// A new version replaces a file's CONTENT, so it must invalidate the thumbnail
// derived from the old content — against a real database.
//
// `POST /files/:id/versions` rewrites the row's objectKey/size/mimeType and
// already clears `hlsReady` for exactly this reason: HLS segments are keyed by
// fileId alone and `/stream/hls/:name` gates on nothing but that flag, so a
// stale flag serves the PREVIOUS file's video under the new one.
//
// `File.thumbnailKey` has the identical shape and was the half nobody cleared:
//
//   * `GET /files/:id/thumbnail` gates on nothing but the key being set.
//   * thumbnail.service.js derives the key from the SOURCE object key
//     (`sourceKey.replace(/^u\//,'t/') + '.webp'`), and objectKeyFor() mints a
//     fresh UUID per write — so after a version upload the stored key still
//     points at the object of the version that was just superseded.
//   * the route regenerates a thumbnail only when the NEW content is an image
//     (canThumbnail / canVideoThumbnail). Every other case leaves the old key
//     in place forever, because postProcessMedia() handles faststart/HLS/
//     whisper and never touches thumbnails.
//
// So the file list and every preview keep rendering the old version's picture
// as the current file's thumbnail, and the superseded thumbnail object is never
// removed by any delete path once the key stops referencing it.
//
// Not reachable from the unit suite: the defect is what the route writes (or
// fails to write) to a row, so it only shows against a real DB.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';

const removed = [];

vi.mock('../../src/services/storage.service.js', () => ({
  objectKeyFor: (userId, ext) => `u/${userId}/${Math.random().toString(36).slice(2)}.${ext}`,
  initiateMultipart: vi.fn(async () => 'up-1'),
  uploadPart: vi.fn(async () => ({})),
  completeMultipart: vi.fn(async () => ({})),
  abortMultipart: vi.fn(async () => {}),
  putObjectStream: vi.fn(async () => {}),
  putObjectBuffer: vi.fn(async () => {}),
  getObjectStream: vi.fn(async () => null),
  getObjectRange: vi.fn(async () => null),
  removeObject: vi.fn(async (key) => {
    removed.push(key);
  }),
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
vi.mock('../../src/services/hls.service.js', () => ({
  removeHls: vi.fn(async () => {}),
  maybeGenerateHls: vi.fn(async () => {}),
}));

// The new content decides whether a fresh thumbnail is generated. Both hooks are
// controllable per test so we can cover the case that regenerates and the case
// that does not — the latter is where a stale key survives.
const canThumbnail = vi.fn(() => false);
const generateThumbnail = vi.fn(async () => null);
vi.mock('../../src/services/thumbnail.service.js', () => ({
  canThumbnail: (...a) => canThumbnail(...a),
  generateThumbnail: (...a) => generateThumbnail(...a),
}));
vi.mock('../../src/services/video.service.js', () => ({
  canFaststart: vi.fn(() => false),
  optimizeFileVideo: vi.fn(async () => {}),
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
  removed.length = 0;
  canThumbnail.mockReturnValue(false);
  generateThumbnail.mockResolvedValue(null);
});

afterAll(async () => {
  await disconnect();
});

/** Give a file the thumbnail a previous upload would have produced. */
async function withThumbnail(file) {
  const thumbnailKey = file.objectKey.replace(/^u\//, 't/') + '.webp';
  await prisma.file.update({
    where: { id: file.id },
    data: { thumbnailKey, hasPreview: true },
  });
  return thumbnailKey;
}

describe('POST /files/:id/versions — thumbnail invalidation', () => {
  it('drops the previous version thumbnail when the new content has none', async () => {
    const user = await makeUser();
    const { auth } = await login(user);
    const file = await makeFile(user, { name: 'chart.png', mimeType: 'image/png', size: 1000 });
    const oldThumb = await withThumbnail(file);

    // The new content is a plain text file: nothing regenerates a thumbnail, so
    // whatever the route leaves in thumbnailKey is what the app serves forever.
    const res = await request(app)
      .post(`/api/files/${file.id}/versions`)
      .set('Authorization', auth)
      .attach('file', Buffer.from('just text now'), {
        filename: 'chart.txt',
        contentType: 'text/plain',
      });
    expect(res.status).toBe(201);

    const after = await prisma.file.findUnique({ where: { id: file.id } });
    // The stale key must not survive — /files/:id/thumbnail gates on nothing else,
    // so keeping it serves the OLD version's picture as the new content's preview.
    expect(after.thumbnailKey).not.toBe(oldThumb);
    expect(after.thumbnailKey).toBeNull();
    expect(after.hasPreview).toBe(false);
  });

  it('removes the superseded thumbnail object', async () => {
    const user = await makeUser();
    const { auth } = await login(user);
    const file = await makeFile(user, { name: 'photo.png', mimeType: 'image/png', size: 1000 });
    const oldThumb = await withThumbnail(file);

    const res = await request(app)
      .post(`/api/files/${file.id}/versions`)
      .set('Authorization', auth)
      .attach('file', Buffer.from('text'), {
        filename: 'photo.txt',
        contentType: 'text/plain',
      });
    expect(res.status).toBe(201);

    // Once the key is cleared nothing references the object again, and no delete
    // path can find it — the row no longer names it.
    expect(removed).toContain(oldThumb);
  });

  it('generates a thumbnail for the new content when it supports one', async () => {
    // This path generated NO thumbnail at all, for any content type — so a new
    // version of an image kept the FIRST version's preview forever. Clearing the
    // stale key is only half the rule; the new content owes its own thumbnail,
    // exactly as every other upload path produces one.
    const user = await makeUser();
    const { auth } = await login(user);
    const file = await makeFile(user, { name: 'pic.png', mimeType: 'image/png', size: 1000 });
    const oldThumb = await withThumbnail(file);

    canThumbnail.mockReturnValue(true);
    generateThumbnail.mockResolvedValue('t/regenerated.webp');

    const res = await request(app)
      .post(`/api/files/${file.id}/versions`)
      .set('Authorization', auth)
      .attach('file', Buffer.from('new image bytes'), {
        filename: 'pic.png',
        contentType: 'image/png',
      });
    expect(res.status).toBe(201);
    expect(generateThumbnail).toHaveBeenCalled();
    // The superseded object still goes, and the regenerated key replaces it.
    expect(removed).toContain(oldThumb);

    // The generation is async/best-effort, so settle the microtask queue first.
    await new Promise((r) => setTimeout(r, 50));
    const after = await prisma.file.findUnique({ where: { id: file.id } });
    expect(after.thumbnailKey).toBe('t/regenerated.webp');
    expect(after.hasPreview).toBe(true);
  });

  it('leaves a file that never had a thumbnail alone', async () => {
    // Control: nothing to invalidate, and no spurious object removal.
    const user = await makeUser();
    const { auth } = await login(user);
    const file = await makeFile(user, { name: 'notes.txt', size: 1000 });

    const res = await request(app)
      .post(`/api/files/${file.id}/versions`)
      .set('Authorization', auth)
      .attach('file', Buffer.from('more text'), {
        filename: 'notes.txt',
        contentType: 'text/plain',
      });
    expect(res.status).toBe(201);

    const after = await prisma.file.findUnique({ where: { id: file.id } });
    expect(after.thumbnailKey).toBeNull();
    expect(removed).toHaveLength(0);
  });
});
