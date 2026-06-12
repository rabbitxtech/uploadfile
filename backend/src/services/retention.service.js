// Task 6 — trash retention. A background sweep hard-deletes files/folders that
// have sat in trash longer than TRASH_RETENTION_DAYS, freeing MinIO storage and
// refunding each owner's quota. Mirrors the manual hard-delete in trash.routes.js
// but batches the quota refund per owner. Best-effort: never throws into boot.
import { prisma } from '../config/prisma.js';
import { logger } from '../config/logger.js';
import { env } from '../config/env.js';
import { removeObject } from './storage.service.js';
import { removeHls } from './hls.service.js';
import { subUsage } from './quota.service.js';

const SIX_HOURS = 6 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

// Purge everything trashed before the retention cutoff. Returns a summary.
export async function purgeExpiredTrash() {
  const days = env.trashRetentionDays;
  if (!days || days <= 0) return { files: 0, folders: 0, freedBytes: '0' };
  const cutoff = new Date(Date.now() - days * DAY_MS);

  const files = await prisma.file.findMany({
    where: { trashedAt: { not: null, lt: cutoff } },
    include: { versions: true },
  });

  const freedByOwner = new Map();
  let freed = 0n;
  for (const f of files) {
    let bytes = 0n;
    for (const v of f.versions) {
      await removeObject(v.objectKey).catch(() => {});
      bytes += BigInt(v.size);
    }
    if (f.thumbnailKey) await removeObject(f.thumbnailKey).catch(() => {});
    if (f.hlsReady) await removeHls(f.id).catch(() => {});
    await prisma.file.delete({ where: { id: f.id } }).catch(() => {});
    freedByOwner.set(f.ownerId, (freedByOwner.get(f.ownerId) || 0n) + bytes);
    freed += bytes;
  }
  for (const [ownerId, bytes] of freedByOwner) {
    await subUsage(ownerId, Number(bytes)).catch(() => {});
  }

  // Folders hold no MinIO objects of their own (files are handled above, and a
  // trashed folder's files are themselves trashed) — just drop the rows.
  const folders = await prisma.folder.deleteMany({
    where: { trashedAt: { not: null, lt: cutoff } },
  });

  if (files.length || folders.count) {
    logger.info(
      { files: files.length, folders: folders.count, freedBytes: freed.toString(), olderThanDays: days },
      '[retention] purged expired trash',
    );
  }
  return { files: files.length, folders: folders.count, freedBytes: freed.toString() };
}

// Schedule the sweep: once a minute after boot, then every 6 hours. Uses unref()
// so the timers never keep the process alive on their own.
export function startRetentionJob() {
  const days = env.trashRetentionDays;
  if (!days || days <= 0) {
    logger.info('[retention] auto-clean disabled (TRASH_RETENTION_DAYS<=0)');
    return;
  }
  const run = () =>
    purgeExpiredTrash().catch((e) => logger.warn({ err: e?.message }, '[retention] sweep failed'));
  setTimeout(run, 60_000).unref?.();
  setInterval(run, SIX_HOURS).unref?.();
  logger.info({ retentionDays: days }, '[retention] scheduled trash auto-clean (every 6h)');
}
