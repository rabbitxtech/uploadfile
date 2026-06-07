import { prisma } from '../config/prisma.js';
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

export async function addUsage(userId, delta) {
  await prisma.user.update({
    where: { id: userId },
    data: { usedBytes: { increment: BigInt(delta) } },
  });
}

export async function subUsage(userId, delta) {
  const d = BigInt(delta);
  if (d <= 0n) return;
  await prisma.user.update({
    where: { id: userId },
    data: { usedBytes: { decrement: d } },
  });
}
