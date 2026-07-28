// A bulk folder purge must not delete a folder that still holds a LIVE FILE.
//
// `deletableFolderIds` exists because `Folder.parent` is `onDelete: Cascade`, so
// deleting an expired folder silently takes its whole subtree. It answers that
// by skipping any candidate with a surviving *descendant folder* — and that is
// the whole of what it looks at. A surviving **file** is not a folder, so it was
// invisible to the guard.
//
// The state is created by the codebase's own rules, not by an attack:
//
//   1. The user trashes "/docs". Trashing stamps the folder AND its files with
//      one timestamp.
//   2. The user restores ONE file out of it (the Trash page lists trashed files
//      and trashed folders in two separate tables, so this is one click). Restore
//      un-trashes exactly the ids it is handed and never walks up in a way that
//      is visible here — the file is live again, the folder is still trashed.
//   3. Both bulk delete paths already SKIP that file: `purgeExpiredTrash` and
//      `POST /trash/empty` both filter out a trashed file whose folder is live,
//      and the file here is not even trashed, so it was never a candidate.
//
// Step 3 is exactly what makes the folder delete destructive. The file survives
// the file half of the sweep, and then the folder half deletes the folder out
// from under it: `File.folder` is `SetNull`, so the row is not deleted — it is
// silently RELOCATED to the root, which the module's own header calls out as
// "harder to diagnose than an outright delete". The user finds a file they
// rescued sitting somewhere they never put it, with no error anywhere, and no
// record that its folder ever existed.
//
// This is the file-side twin of the guard that already exists for folders:
// `retention-restored-file.test.js` and `trash-empty-restored-file.test.js`
// pin that the restored FILE is not deleted; nothing pinned that the folder it
// lives in survives to hold it.
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

process.env.TRASH_RETENTION_DAYS = '30';

const { prisma, migrateTestDb, resetDb, disconnect } = await import('../helpers/db.js');
const { makeUser, makeFile, login } = await import('../helpers/fixtures.js');
const { purgeExpiredTrash } = await import('../../src/services/retention.service.js');
const { buildApp } = await import('../../src/app.js');

const app = buildApp();

const DAY = 24 * 60 * 60 * 1000;
const expired = () => new Date(Date.now() - 40 * DAY);

beforeAll(() => {
  migrateTestDb();
}, 120_000);

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await disconnect();
});

const folderAlive = async (f) => !!(await prisma.folder.findUnique({ where: { id: f.id } }));
const folderOf = async (f) =>
  (await prisma.file.findUnique({ where: { id: f.id }, select: { folderId: true } }))?.folderId;

async function trashedFolder(user, { name = 'docs', parentId = null, path = null } = {}) {
  return prisma.folder.create({
    data: {
      name,
      path: path ?? `/${name}`,
      parentId,
      ownerId: user.id,
      trashedAt: expired(),
    },
  });
}

describe('retention sweep → a folder holding a live file', () => {
  it('does not delete a trashed folder that still holds a LIVE file', async () => {
    const user = await makeUser();
    const folder = await trashedFolder(user);
    // The file was restored out of the trashed folder: live row, trashed parent.
    const file = await makeFile(user, { folderId: folder.id, trashedAt: null });

    await purgeExpiredTrash();

    expect(await folderAlive(folder)).toBe(true);
    // And the file must still be where the user left it, not orphaned to root.
    expect(await folderOf(file)).toBe(folder.id);
  });

  it('does not delete an ANCESTOR of a folder holding a live file', async () => {
    // The live file sits deeper than the expired folder, so the cascade is what
    // would reach it — the same shape the folder-survivor guard already covers.
    const user = await makeUser();
    const parent = await trashedFolder(user, { name: 'docs' });
    const child = await trashedFolder(user, {
      name: '2025',
      parentId: parent.id,
      path: '/docs/2025',
    });
    const file = await makeFile(user, { folderId: child.id, trashedAt: null });

    await purgeExpiredTrash();

    expect(await folderAlive(parent)).toBe(true);
    expect(await folderAlive(child)).toBe(true);
    expect(await folderOf(file)).toBe(child.id);
  });

  // Control: the ordinary case must keep working, or the guard is just a way to
  // stop the sweep ever collecting anything.
  it('still deletes a trashed folder whose files are all trashed too', async () => {
    const user = await makeUser();
    const folder = await trashedFolder(user);
    await makeFile(user, { folderId: folder.id, trashedAt: expired() });

    await purgeExpiredTrash();

    expect(await folderAlive(folder)).toBe(false);
  });

  it('still deletes an empty trashed folder', async () => {
    const user = await makeUser();
    const folder = await trashedFolder(user);

    await purgeExpiredTrash();

    expect(await folderAlive(folder)).toBe(false);
  });

  // Folder.path is names-only and NOT namespaced per owner, so a stranger's
  // identically-named folder must not block a purge — the same rule the folder
  // survivor comparison is grouped by owner for.
  it('is not blocked by another owner\'s live file at the same path', async () => {
    const user = await makeUser();
    const other = await makeUser();
    const folder = await trashedFolder(user, { name: 'docs' });
    const otherFolder = await prisma.folder.create({
      data: { name: 'docs', path: '/docs', ownerId: other.id, trashedAt: null },
    });
    await makeFile(other, { folderId: otherFolder.id, trashedAt: null });

    await purgeExpiredTrash();

    expect(await folderAlive(folder)).toBe(false);
  });
});

describe('POST /trash/empty → a folder holding a live file', () => {
  it('does not delete a trashed folder that still holds a LIVE file', async () => {
    const user = await makeUser();
    const { auth } = await login(user);
    const folder = await trashedFolder(user);
    const file = await makeFile(user, { folderId: folder.id, trashedAt: null });

    const res = await request(app).post('/api/trash/empty').set('Authorization', auth);
    expect(res.status).toBe(200);

    expect(await folderAlive(folder)).toBe(true);
    expect(await folderOf(file)).toBe(folder.id);
  });

  it('does not delete a trashed folder holding a file restored out of it', async () => {
    // The exact production sequence: trash the folder (stamping its file too),
    // then restore just the file. `POST /trash/empty` is the button the user
    // presses next to reclaim space.
    const user = await makeUser();
    const { auth } = await login(user);
    const folder = await trashedFolder(user);
    const file = await makeFile(user, { folderId: folder.id, trashedAt: expired() });

    const restore = await request(app)
      .post('/api/trash/restore')
      .set('Authorization', auth)
      .send({ fileIds: [file.id] });
    expect(restore.status).toBe(200);

    await request(app).post('/api/trash/empty').set('Authorization', auth).expect(200);

    expect(await folderOf(file)).toBe(folder.id);
  });

  it('still empties a trashed folder whose files are all trashed', async () => {
    const user = await makeUser();
    const { auth } = await login(user);
    const folder = await trashedFolder(user);
    await makeFile(user, { folderId: folder.id, trashedAt: expired() });

    await request(app).post('/api/trash/empty').set('Authorization', auth).expect(200);

    expect(await folderAlive(folder)).toBe(false);
  });
});
