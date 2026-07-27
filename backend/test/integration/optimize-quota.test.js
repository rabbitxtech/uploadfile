// The faststart remux reconciles the quota, and it owes the same two rules
// every other size-changing path in this codebase obeys.
//
// `optimizeFileVideo` rewrites a video's object in place (a lossless container
// remux — same content, smaller container) and then has to bring the bookkeeping
// back in line with the new object size. It got both halves wrong:
//
//  1. It wrote `usedBytes: { increment: delta }` directly on the User row. A
//     remux usually SHRINKS the file, so that is a bare decrement — the exact
//     pattern subUsage exists to replace, and the only write to usedBytes
//     anywhere in the codebase that did not go through quota.service. With
//     nothing flooring it at zero, a refund larger than the balance leaves
//     usedBytes NEGATIVE (confirmed directly against Postgres: 100 + (-999)
//     stores as -899). A negative balance makes assertQuota pass for ANY size:
//     silent unlimited storage, with no path back.
//
//  2. It updated `File.size` but not the file's FileVersion row. Every
//     hard-delete path (trash.routes.js, the retention sweep, the replace branch
//     of upload/complete) refunds the SUM of versions[].size, NOT File.size — so
//     after a remux the file was charged the new size while its eventual refund
//     was still computed from the old one. Delete it afterwards and the counter
//     is permanently off by the difference, unreconcilable once the rows go.
//
// Both are silent. The drift only surfaces later as a user who cannot upload
// into space they are not using — or one whose quota stopped meaning anything.
//
// The reconciliation is tested through `reconcileRemuxedSize`, the helper
// optimizeFileVideo delegates to: it is the whole of the bookkeeping, and
// testing it directly keeps ffmpeg and MinIO out of the test.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';

const { prisma, migrateTestDb, resetDb, disconnect } = await import('../helpers/db.js');
const { makeUser, makeFile } = await import('../helpers/fixtures.js');
const { reconcileRemuxedSize } = await import('../../src/services/video.service.js');
const { assertQuota } = await import('../../src/services/quota.service.js');

beforeAll(() => { migrateTestDb(); }, 120_000);
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await disconnect(); });

async function usedBytes(userId) {
  const u = await prisma.user.findUnique({ where: { id: userId } });
  return BigInt(u.usedBytes);
}
async function versionSum(fileId) {
  const vs = await prisma.fileVersion.findMany({ where: { fileId } });
  return vs.reduce((n, v) => n + BigInt(v.size), 0n);
}
/** A file plus a usedBytes balance, as the app would have them. */
async function seed({ size, used, quota = 100_000n }) {
  const u = await makeUser({ quotaBytes: quota });
  const file = await makeFile(u, { size, mimeType: 'video/mp4' });
  await prisma.user.update({ where: { id: u.id }, data: { usedBytes: used } });
  return { u, file: await prisma.file.findUnique({ where: { id: file.id } }) };
}

describe('faststart remux — quota reconciliation', () => {
  it('never drives usedBytes negative when the remux frees more than the balance', async () => {
    // The counter is already BELOW this file's size — the drift the floor exists
    // for (an overlapping refund elsewhere took some of it back first).
    const { u, file } = await seed({ size: 1000, used: 100n });

    await reconcileRemuxedSize(file, 1); // shrink by 999

    expect(await usedBytes(u.id)).toBeGreaterThanOrEqual(0n);
  });

  it('leaves the quota still enforceable after an over-large refund', async () => {
    const { u, file } = await seed({ size: 900, used: 50n, quota: 1000n });

    await reconcileRemuxedSize(file, 10); // refund 890 against a balance of 50

    // With a negative balance this would resolve for ANY size. It must reject.
    await expect(assertQuota(u.id, 5000)).rejects.toThrow();
  });

  it('keeps the FileVersion row in step, so the eventual refund matches the charge', async () => {
    const { u, file } = await seed({ size: 1000, used: 1000n });

    await reconcileRemuxedSize(file, 400); // shrink by 600

    const fresh = await prisma.file.findUnique({ where: { id: file.id } });
    expect(BigInt(fresh.size)).toBe(400n);
    // What every hard-delete path would refund must equal what is now charged.
    expect(await versionSum(file.id)).toBe(400n);
    expect(await usedBytes(u.id)).toBe(400n);
  });

  it('a growing remux charges the difference and stays consistent', async () => {
    const { u, file } = await seed({ size: 1000, used: 1000n });

    await reconcileRemuxedSize(file, 1500);

    expect(await usedBytes(u.id)).toBe(1500n);
    expect(await versionSum(file.id)).toBe(1500n);
  });

  it('does nothing when the size is unchanged', async () => {
    const { u, file } = await seed({ size: 1000, used: 1000n });

    await reconcileRemuxedSize(file, 1000);

    expect(await usedBytes(u.id)).toBe(1000n);
    expect(await versionSum(file.id)).toBe(1000n);
  });

  it('only moves the CURRENT version — older versions keep their own bytes', async () => {
    // A file with history: v1 is superseded and still points at its own object,
    // so the remux of the current bytes must not rewrite its size.
    const { u, file } = await seed({ size: 1000, used: 1300n });
    await prisma.fileVersion.create({
      data: { fileId: file.id, version: 2, objectKey: 'u/x/v2', size: 300n },
    });
    await prisma.file.update({ where: { id: file.id }, data: { currentVersion: 2 } });
    const fresh = await prisma.file.findUnique({ where: { id: file.id } });

    await reconcileRemuxedSize({ ...fresh, size: 300n }, 100); // v2: 300 -> 100

    const v1 = await prisma.fileVersion.findFirst({ where: { fileId: file.id, version: 1 } });
    const v2 = await prisma.fileVersion.findFirst({ where: { fileId: file.id, version: 2 } });
    expect(BigInt(v1.size)).toBe(1000n); // untouched
    expect(BigInt(v2.size)).toBe(100n);
    expect(await usedBytes(u.id)).toBe(1100n); // 1300 - 200
  });
});
