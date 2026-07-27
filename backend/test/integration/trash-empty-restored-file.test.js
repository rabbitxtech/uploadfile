// POST /trash/empty must not destroy a file whose folder was restored.
//
// Same hazard as the retention sweep (retention-restored-file.test.js), reached
// by a button instead of a timer. `POST /trash/empty` hard-deletes every file
// with a non-null `trashedAt` for the owner — but restore un-trashes only the
// ids it is handed and never walks down, so restoring a folder leaves its files
// stamped while the folder itself is live and listed again.
//
// The user restores a folder, sees it back in their files, then empties the
// trash to reclaim space — and the contents of the folder they just rescued are
// destroyed, with no warning and nothing in the trash view naming them as at
// risk (the trash lists files by name, but the user has already decided the
// folder is a keeper).
//
// `/trash/empty` already reasons about exactly this for FOLDERS via
// deletableFolderIds; the file half was missing. The manual per-file delete
// (`DELETE /trash/file/:id`) is deliberately NOT covered by the rule: there the
// user named that one file explicitly.
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

const trashed = () => new Date(Date.now() - 60_000);

async function makeTrashedFileIn(user, folder, { name = 'doc.txt', size = 100n } = {}) {
  return prisma.file.create({
    data: {
      name,
      originalName: name,
      mimeType: 'text/plain',
      size,
      objectKey: `u/${user.id}/${name}`,
      bucket: 'uploads',
      ownerId: user.id,
      folderId: folder?.id ?? null,
      trashedAt: trashed(),
      versions: { create: { version: 1, objectKey: `u/${user.id}/${name}`, size } },
    },
  });
}

const fileAlive = async (f) => !!(await prisma.file.findUnique({ where: { id: f.id } }));

describe('POST /api/trash/empty → restored folder protects its files', () => {
  it('keeps a trashed file that now sits in a LIVE folder', async () => {
    const user = await makeUser();
    const { auth } = await login(user);
    const folder = await prisma.folder.create({
      data: { name: 'keep', path: '/keep', ownerId: user.id, trashedAt: null },
    });
    const file = await makeTrashedFileIn(user, folder);

    const res = await request(app)
      .post('/api/trash/empty')
      .set('Authorization', auth)
      .send({});
    expect(res.status).toBe(200);

    expect(await fileAlive(file)).toBe(true);
  });

  it('still empties a trashed file whose folder is trashed too', async () => {
    const user = await makeUser();
    const { auth } = await login(user);
    const folder = await prisma.folder.create({
      data: { name: 'gone', path: '/gone', ownerId: user.id, trashedAt: trashed() },
    });
    const file = await makeTrashedFileIn(user, folder);

    await request(app).post('/api/trash/empty').set('Authorization', auth).send({});

    expect(await fileAlive(file)).toBe(false);
  });

  it('still empties a trashed file at the root', async () => {
    const user = await makeUser();
    const { auth } = await login(user);
    const file = await makeTrashedFileIn(user, null);

    await request(app).post('/api/trash/empty').set('Authorization', auth).send({});

    expect(await fileAlive(file)).toBe(false);
  });

  // The bytes of a file that was held back must stay on the counter: refunding
  // them while the object and the row are both still there is the drift the
  // version-sum refunds exist to prevent.
  it('only refunds the bytes it actually deleted', async () => {
    const user = await makeUser();
    const { auth } = await login(user);
    await prisma.user.update({ where: { id: user.id }, data: { usedBytes: 300n } });
    const live = await prisma.folder.create({
      data: { name: 'keep', path: '/keep', ownerId: user.id, trashedAt: null },
    });
    await makeTrashedFileIn(user, live, { name: 'kept.txt', size: 100n });
    await makeTrashedFileIn(user, null, { name: 'gone.txt', size: 200n });

    const res = await request(app)
      .post('/api/trash/empty')
      .set('Authorization', auth)
      .send({});

    expect(res.body.freedBytes).toBe('200');
    const after = await prisma.user.findUnique({ where: { id: user.id } });
    expect(after.usedBytes).toBe(100n); // the held-back file is still charged
  });

  // The per-file delete is an explicit instruction about one named file, so it
  // keeps working regardless of where that file now sits.
  it('DELETE /trash/file/:id still deletes a file in a live folder', async () => {
    const user = await makeUser();
    const { auth } = await login(user);
    const folder = await prisma.folder.create({
      data: { name: 'keep', path: '/keep', ownerId: user.id, trashedAt: null },
    });
    const file = await makeTrashedFileIn(user, folder);

    const res = await request(app)
      .delete(`/api/trash/file/${file.id}`)
      .set('Authorization', auth);
    expect(res.status).toBe(200);

    expect(await fileAlive(file)).toBe(false);
  });
});
