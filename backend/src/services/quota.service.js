import { prisma } from '../config/prisma.js';
import { logger } from '../config/logger.js';
import { payloadTooLarge } from '../utils/errors.js';

export async function assertQuota(userId, additionalBytes) {
  const u = await prisma.user.findUnique({
    where: { id: userId },
    select: { quotaBytes: true, usedBytes: true },
  });
  if (!u) return;
  const used = BigInt(u.usedBytes);
  const quota = BigInt(u.quotaBytes);
  const add = BigInt(additionalBytes);
  if (used + add > quota) {
    throw payloadTooLarge(
      `Quota exceeded: used ${used} + ${add} > ${quota}`,
    );
  }
}

/**
 * Bytes an overwrite will actually add to the owner's usage.
 *
 * An overwrite refunds the old bytes and charges for the new ones, so only the
 * difference is ever owed — charging the gross size refuses a same-size
 * overwrite for anyone near their limit. Floored at zero because assertQuota
 * takes a NON-NEGATIVE addition: a shrinking overwrite frees space rather than
 * reserving any, and feeding the raw negative delta in would make the check
 * mean something different here than at every other call site.
 *
 * Both operands go through BigInt — `size - Number(existing.size)` loses
 * precision past 2^53 and is exactly the conversion the byte-total rule bans.
 */
export function netCost(uploadBytes, refundBytes) {
  const net = BigInt(uploadBytes) - BigInt(refundBytes);
  return net > 0n ? net : 0n;
}

export async function addUsage(userId, delta) {
  await prisma.user.update({
    where: { id: userId },
    data: { usedBytes: { increment: BigInt(delta) } },
  });
}

export async function subUsage(userId, delta) {
  const d = BigInt(delta);
  if (d <= 0n) return;
  // Floor at zero rather than a bare `decrement`. Every refund path reads the
  // byte total BEFORE deleting the rows, so two refunds can overlap — the
  // retention sweep racing POST /trash/empty, or a retried hard-delete. An
  // unfloored decrement turns that drift into a NEGATIVE usedBytes, which makes
  // assertQuota pass for any size: the user silently gets unlimited storage,
  // and nothing ever brings the counter back up.
  //
  // Done as a conditional decrement + clamp so it stays provider-portable
  // (switch-db.js supports postgresql/mysql/sqlite). The `usedBytes: { gte: d }`
  // guard makes the common case a single atomic statement; the fallback only
  // runs when the refund really is larger than the balance.
  const updated = await prisma.user.updateMany({
    where: { id: userId, usedBytes: { gte: d } },
    data: { usedBytes: { decrement: d } },
  });
  if (updated.count > 0) return;

  // Under-balance: clamp to zero. This must stay conditional on the balance we
  // decided against — a bare `set 0` would also erase an addUsage that landed
  // between the two statements, turning a harmless over-refund into lost usage
  // for an unrelated upload. Re-read and retry so a racing writer that pushed
  // the balance back above `d` takes the atomic decrement path instead.
  for (let attempt = 0; attempt < 3; attempt++) {
    const u = await prisma.user.findUnique({ where: { id: userId }, select: { usedBytes: true } });
    if (!u) return;
    if (BigInt(u.usedBytes) >= d) {
      const again = await prisma.user.updateMany({
        where: { id: userId, usedBytes: { gte: d } },
        data: { usedBytes: { decrement: d } },
      });
      if (again.count > 0) return;
      continue;
    }
    const cleared = await prisma.user.updateMany({
      where: { id: userId, usedBytes: u.usedBytes },
      data: { usedBytes: 0n },
    });
    if (cleared.count > 0) return;
  }

  // Sustained contention on this one row beat every attempt. Erring this way is
  // the safe direction — usedBytes stays too HIGH, so the user is over-charged
  // rather than handed free storage — but a refund that silently does nothing is
  // exactly the kind of drift nobody notices until the counter is far off, so
  // leave a trace that explains it.
  logger.warn(
    { userId, delta: d.toString() },
    '[quota] subUsage gave up after repeated contention; usedBytes not refunded',
  );
}
