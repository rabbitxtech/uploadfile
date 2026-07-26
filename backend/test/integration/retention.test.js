// Trash retention sweep, against a real database.
//
// The sweep hard-deletes rows on a timer with nobody watching, so a mistake
// here destroys data silently and is only noticed long after the fact. The
// cascade behaviour it has to respect lives in the schema, not in the service,
// which is why this needs a real database rather than a mock.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

// The sweep touches MinIO for every purged file; this suite is about which rows
// survive, so object removal is stubbed.
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
const recent = () => new Date(Date.now() - 1 * DAY);

beforeAll(() => {
  migrateTestDb();
}, 120_000);

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await disconnect();
});

const alive = async (folder) =>
  !!(await prisma.folder.findUnique({ where: { id: folder.id } }));

describe('purgeExpiredTrash → folder cascade safety', () => {
  // Folder.parent is onDelete: Cascade, so deleting an expired folder takes its
  // whole subtree with it. Trashing a folder stamps the subtree with one
  // timestamp so they normally expire together — but restore un-trashes only
  // the exact ids it is given. Restoring a child out of a long-trashed parent
  // therefore used to hand the sweep a live folder to destroy, and its files
  // were orphaned to the root (File.folder is SetNull) rather than deleted.
  it('does not delete a restored child of an expired parent', async () => {
    const user = await makeUser();
    const parent = await prisma.folder.create({
      data: { name: 'old', path: '/old', ownerId: user.id, trashedAt: expired() },
    });
    const restored = await prisma.folder.create({
      data: {
        name: 'keep',
        path: '/old/keep',
        ownerId: user.id,
        parentId: parent.id,
        trashedAt: null,
      },
    });

    await purgeExpiredTrash();

    expect(await alive(restored)).toBe(true);
    // The parent is held back too — deleting it is what would take the child.
    expect(await alive(parent)).toBe(true);
  });

  // Same hazard, but the descendant is merely trashed more recently than the
  // parent. It still has retention time left and must not be cut short.
  it('does not delete a not-yet-expired descendant', async () => {
    const user = await makeUser();
    const parent = await prisma.folder.create({
      data: { name: 'old', path: '/old', ownerId: user.id, trashedAt: expired() },
    });
    const child = await prisma.folder.create({
      data: {
        name: 'fresh',
        path: '/old/fresh',
        ownerId: user.id,
        parentId: parent.id,
        trashedAt: recent(),
      },
    });

    await purgeExpiredTrash();

    expect(await alive(child)).toBe(true);
    expect(await alive(parent)).toBe(true);
  });

  // The deferral must not turn into "never collected": once the whole subtree
  // has expired, all of it goes.
  it('purges a subtree whose folders have all expired', async () => {
    const user = await makeUser();
    const parent = await prisma.folder.create({
      data: { name: 'gone', path: '/gone', ownerId: user.id, trashedAt: expired() },
    });
    const child = await prisma.folder.create({
      data: {
        name: 'sub',
        path: '/gone/sub',
        ownerId: user.id,
        parentId: parent.id,
        trashedAt: expired(),
      },
    });

    const res = await purgeExpiredTrash();

    expect(await alive(parent)).toBe(false);
    expect(await alive(child)).toBe(false);
    expect(res.folders).toBe(2);
  });

  // A folder at the same path belonging to someone else must not count as a
  // live descendant — Folder.path is names only and is not namespaced by owner,
  // so a path-prefix query that forgets the owner sees another user's tree.
  it('ignores another owner\'s identically-named folder when deciding', async () => {
    const owner = await makeUser();
    const other = await makeUser();
    const parent = await prisma.folder.create({
      data: { name: 'gone', path: '/gone', ownerId: owner.id, trashedAt: expired() },
    });
    // Same path, different owner, very much alive.
    await prisma.folder.create({
      data: { name: 'sub', path: '/gone/sub', ownerId: other.id, trashedAt: null },
    });

    await purgeExpiredTrash();

    expect(await alive(parent)).toBe(false); // not blocked by a stranger's folder
  });

  it('leaves folders that are not trashed at all', async () => {
    const user = await makeUser();
    const live = await prisma.folder.create({
      data: { name: 'live', path: '/live', ownerId: user.id, trashedAt: null },
    });

    await purgeExpiredTrash();

    expect(await alive(live)).toBe(true);
  });
});

describe('purgeExpiredTrash → quota refund', () => {
  it('refunds the purged bytes to the owner', async () => {
    const user = await makeUser();
    await prisma.user.update({ where: { id: user.id }, data: { usedBytes: 500n } });

    const file = await prisma.file.create({
      data: {
        name: 'old.txt',
        originalName: 'old.txt',
        mimeType: 'text/plain',
        size: 500n,
        objectKey: 'u/old.txt',
        bucket: 'uploads',
        ownerId: user.id,
        trashedAt: expired(),
        versions: { create: { version: 1, objectKey: 'u/old.txt', size: 500n } },
      },
    });

    await purgeExpiredTrash();

    expect(await prisma.file.findUnique({ where: { id: file.id } })).toBeNull();
    const after = await prisma.user.findUnique({ where: { id: user.id } });
    expect(after.usedBytes).toBe(0n);
  });

  // subUsage floors at zero: a double refund (retention racing a manual empty)
  // must not drive usedBytes negative, which would make assertQuota pass for
  // any size and hand the user unlimited storage.
  it('never drives usedBytes below zero', async () => {
    const user = await makeUser();
    await prisma.user.update({ where: { id: user.id }, data: { usedBytes: 100n } });

    await prisma.file.create({
      data: {
        name: 'big.txt',
        originalName: 'big.txt',
        mimeType: 'text/plain',
        size: 900n, // more than the counter says is in use
        objectKey: 'u/big.txt',
        bucket: 'uploads',
        ownerId: user.id,
        trashedAt: expired(),
        versions: { create: { version: 1, objectKey: 'u/big.txt', size: 900n } },
      },
    });

    await purgeExpiredTrash();

    const after = await prisma.user.findUnique({ where: { id: user.id } });
    expect(after.usedBytes).toBe(0n);
  });
});
