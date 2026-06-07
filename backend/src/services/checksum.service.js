import crypto from 'crypto';
import { getObjectStream } from './storage.service.js';
import { prisma } from '../config/prisma.js';

export function sha256Buffer(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// Stream the stored object, compute its sha256, and persist it on the File and
// its matching version. Best-effort — used after chunked uploads where the
// whole buffer isn't held in memory (H2 duplicate detection).
export async function backfillChecksum(fileId, objectKey) {
  try {
    const stream = await getObjectStream(objectKey);
    const hash = crypto.createHash('sha256');
    for await (const chunk of stream) hash.update(chunk);
    const checksum = hash.digest('hex');
    await prisma.file.update({ where: { id: fileId }, data: { checksum } });
    await prisma.fileVersion.updateMany({ where: { fileId, objectKey }, data: { checksum } });
    return checksum;
  } catch (e) {
    console.warn('[checksum] failed:', e?.message);
    return null;
  }
}
