// The retention sweep must not destroy a file whose folder was restored.
//
// `trashedAt` is per-row, and restore un-trashes only the exact ids it is
// handed — it deliberately does NOT walk down into a folder's contents (that
// would undo the user's choice when they restore a folder but want only some of
// it back). The sweep, meanwhile, hard-deletes any file whose own `trashedAt` is
// past the cutoff, with no regard for where that file now lives.
//
// Those two rules combine into silent data loss. Trashing a folder stamps the
// folder AND its files with one timestamp; restoring the folder alone brings the
// folder back live and visible in the listing, while its files keep the old
// stamp. The user sees a restored folder, opens it, sees nothing, and assumes
// the files are still on their way back — and 30 days after the original delete
// the sweep hard-deletes them, objects and all, out of a folder that is live.
//
// This is the file-side twin of the folder guard `deletableFolderIds` already
// provides: that one stops the cascade destroying a restored CHILD FOLDER, and
// is pinned by retention.test.js. Nothing covered the file case.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

vi.mock('../../src/services/storage.service.js', () => ({
  removeObject: vi.fn(async () => {}),
  removePrefix: vi.fn(async () => {}),
}));
vi.mock('../../src/services/hls.service.js', () => ({
  removeHls: vi.fn(async () => {}),
  hlsPrefix: (id) => `h/${id}/`,
}));

process.env.TRASH_RETENTION_DAYS = '30';

const { prisma, migrateTestDb, resetDb, disconnect } = await import('../helpers/db.js');
const { makeUser } = await import('../helpers/fixtures.js');
const { purgeExpiredTrash } = await import('../../src/services/retention.service.js');

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
      trashedAt: expired(),
      versions: { create: { version: 1, objectKey: `u/${user.id}/${name}`, size } },
    },
  });
}

const fileAlive = async (f) => !!(await prisma.file.findUnique({ where: { id: f.id } }));

describe('purgeExpiredTrash → restored folder protects its files', () => {
  it('does not delete an expired file sitting in a LIVE folder', async () => {
    const user = await makeUser();
    // The folder was restored: it is live again. Its file still carries the
    // stamp from when the folder was trashed, because restore does not walk down.
    const folder = await prisma.folder.create({
      data: { name: 'keep', path: '/keep', ownerId: user.id, trashedAt: null },
    });
    const file = await makeTrashedFileIn(user, folder);

    await purgeExpiredTrash();

    expect(await fileAlive(file)).toBe(true);
  });

  it('still deletes an expired file whose folder is also trashed', async () => {
    const user = await makeUser();
    const folder = await prisma.folder.create({
      data: { name: 'gone', path: '/gone', ownerId: user.id, trashedAt: expired() },
    });
    const file = await makeTrashedFileIn(user, folder);

    await purgeExpiredTrash();

    expect(await fileAlive(file)).toBe(false);
  });

  it('still deletes an expired file at the root (no folder to protect it)', async () => {
    const user = await makeUser();
    const file = await makeTrashedFileIn(user, null);

    await purgeExpiredTrash();

    expect(await fileAlive(file)).toBe(false);
  });

  // The deferral must not leak quota: a file that is held back must not have
  // its bytes refunded, or the counter drifts down while the bytes are still
  // stored and still owned.
  it('does not refund the quota for a file it held back', async () => {
    const user = await makeUser();
    await prisma.user.update({ where: { id: user.id }, data: { usedBytes: 100n } });
    const folder = await prisma.folder.create({
      data: { name: 'keep', path: '/keep', ownerId: user.id, trashedAt: null },
    });
    await makeTrashedFileIn(user, folder, { size: 100n });

    const res = await purgeExpiredTrash();

    const after = await prisma.user.findUnique({ where: { id: user.id } });
    expect(after.usedBytes).toBe(100n); // untouched
    expect(res.files).toBe(0);
  });
});
