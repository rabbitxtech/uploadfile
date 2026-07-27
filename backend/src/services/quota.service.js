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

/**
 * Atomically RESERVE `delta` bytes against the user's quota.
 *
 * `assertQuota` reads the balance and `addUsage` writes it, and every upload
 * path runs them as two separate statements with the whole upload in between —
 * a read-modify-write on exactly the counter that is supposed to be the limit.
 * Concurrent uploads all read the same pre-upload balance, all decide they fit,
 * and all commit: ten parallel 200-byte uploads against a 1000-byte quota land
 * 2000 bytes, i.e. the quota is exceeded by however many requests are in flight.
 * Browsers upload in parallel by default, so this needs no attacker — and the
 * anonymous drop-box (`POST /shares/public/:token/upload`) reaches it with no
 * credentials at all, which makes an owner's quota unenforceable by a stranger.
 *
 * Fixing it in the two callers is not possible: the gap is between them. So the
 * check and the charge become ONE conditional statement — increment only if the
 * result still fits — which the database serialises per row. `updateMany` with
 * the bound in `where` compiles to a single UPDATE ... WHERE, so two concurrent
 * reservations cannot both see the pre-increment balance.
 *
 * Deliberately expressed with `usedBytes: { lte: quota - delta }` rather than a
 * raw SQL expression: `switch-db.js` supports postgresql/mysql/sqlite, and this
 * stays portable across all three. `quota` is read first, but reading it stale
 * is harmless — a quota change is an admin action, not a per-request race, and
 * the byte bound is still applied atomically against the live `usedBytes`.
 *
 * Returns nothing; throws the same 413 assertQuota throws, so call sites keep
 * their existing error handling. On failure NOTHING is reserved.
 */
export async function reserveQuota(userId, additionalBytes) {
  const add = BigInt(additionalBytes);
  const u = await prisma.user.findUnique({
    where: { id: userId },
    select: { quotaBytes: true, usedBytes: true },
  });
  if (!u) return; // no such user: nothing to charge, same as assertQuota
  if (add <= 0n) return; // a zero/negative reservation charges nothing

  const quota = BigInt(u.quotaBytes);
  const ceiling = quota - add;
  if (ceiling < 0n) {
    // The single upload is larger than the entire quota — it can never fit, and
    // `lte: negative` would be an unsatisfiable bound reported as contention.
    throw payloadTooLarge(`Quota exceeded: used ${BigInt(u.usedBytes)} + ${add} > ${quota}`);
  }

  const reserved = await prisma.user.updateMany({
    where: { id: userId, usedBytes: { lte: ceiling } },
    data: { usedBytes: { increment: add } },
  });
  if (reserved.count === 0) {
    const fresh = await prisma.user.findUnique({
      where: { id: userId },
      select: { usedBytes: true },
    });
    throw payloadTooLarge(
      `Quota exceeded: used ${BigInt(fresh?.usedBytes ?? u.usedBytes)} + ${add} > ${quota}`,
    );
  }
}

/**
 * Release a reservation made by `reserveQuota` when the upload it was taken for
 * does not become a File row (an error after the reserve, or a path that
 * refuses the upload later on).
 *
 * This is `subUsage` — the floor-at-zero refund — under a name that says why it
 * is being called, so a reserve/release pair reads as one unit at the call site
 * and is not mistaken for a hard-delete refund.
 */
export function releaseQuota(userId, delta) {
  return subUsage(userId, delta);
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
