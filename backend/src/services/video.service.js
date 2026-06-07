import { spawn } from 'node:child_process';
import { mkdtemp, rm, stat, readFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import sharp from 'sharp';
import { minio, BUCKET } from '../config/minio.js';
import { getObjectStream, putObjectBuffer } from './storage.service.js';
import { prisma } from '../config/prisma.js';

const REMUXABLE = new Set(['video/mp4', 'video/quicktime', 'video/x-m4v']);
const THUMBNAILABLE = new Set([
  'video/mp4',
  'video/quicktime',
  'video/x-m4v',
  'video/webm',
  'video/x-matroska',
  'video/avi',
  'video/x-msvideo',
]);

export function canFaststart(mimeType) {
  return REMUXABLE.has(mimeType);
}

export function canVideoThumbnail(mimeType) {
  return THUMBNAILABLE.has(mimeType);
}

// Extract a poster frame from a video and store it as the thumbnail (t/...webp).
// Returns the thumbnail object key, or null on failure. Best-effort.
export async function generateVideoThumbnail(objectKey, mimeType) {
  if (!canVideoThumbnail(mimeType)) return null;
  const dir = await mkdtemp(join(tmpdir(), 'vthumb-'));
  const inPath = join(dir, 'in.bin');
  const framePath = join(dir, 'frame.jpg');
  try {
    const src = await getObjectStream(objectKey);
    await pipeline(src, createWriteStream(inPath));

    // Probe duration so we can grab a frame ~10% in (skips black intros), with a
    // sane cap; fall back to 1s for very short clips.
    let seek = 1;
    try {
      const out = await runCapture('ffprobe', [
        '-v', 'error',
        '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1',
        inPath,
      ]);
      const dur = parseFloat(out);
      if (Number.isFinite(dur) && dur > 0) seek = Math.min(Math.max(1, dur * 0.1), 60);
    } catch {
      /* keep default */
    }

    await run('ffmpeg', [
      '-v', 'error',
      '-ss', String(seek),
      '-i', inPath,
      '-frames:v', '1',
      '-q:v', '3',
      '-y',
      framePath,
    ]);

    const frame = await readFile(framePath);
    const thumb = await sharp(frame)
      .resize({ width: 480, height: 480, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 80 })
      .toBuffer();
    const thumbKey = objectKey.replace(/^u\//, 't/') + '.webp';
    await putObjectBuffer(thumbKey, thumb, 'image/webp');
    return thumbKey;
  } catch (e) {
    console.warn('[vthumb] failed:', e?.message);
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => (err += d.toString()));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}: ${err.slice(-500)}`))));
  });
}

function runCapture(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    p.stdout.on('data', (d) => (out += d.toString()));
    p.on('error', reject);
    p.on('close', () => resolve(out));
  });
}

// Checks whether the local MP4 already has its `moov` atom before `mdat`.
function isFaststartLocal(buf) {
  const moov = buf.indexOf('moov');
  const mdat = buf.indexOf('mdat');
  return moov !== -1 && (mdat === -1 || moov < mdat);
}

// Move the `moov` atom to the front (fast-start) with a lossless stream copy.
// NON-DESTRUCTIVE: never re-encodes, trims, or changes duration/content — only
// rewrites the container so the browser can start + seek without downloading
// the whole file first. Returns the new size in bytes, or null if not needed.
export async function faststartRemux(objectKey, mimeType) {
  if (!canFaststart(mimeType)) return null;

  const dir = await mkdtemp(join(tmpdir(), 'remux-'));
  const inPath = join(dir, 'in.mp4');
  const outPath = join(dir, 'out.mp4');
  try {
    const src = await getObjectStream(objectKey);
    await pipeline(src, createWriteStream(inPath));

    const headBuf = await readFile(inPath).then((b) => b.subarray(0, 1024 * 1024));
    if (isFaststartLocal(headBuf)) return null; // already web-optimized

    await run('ffmpeg', [
      '-v', 'error',
      '-i', inPath,
      '-c', 'copy',
      '-movflags', '+faststart',
      '-y',
      outPath,
    ]);

    const { size } = await stat(outPath);
    if (!size) return null;

    const data = await readFile(outPath);
    await minio.putObject(BUCKET, objectKey, data, size, { 'Content-Type': mimeType });
    return size;
  } catch (e) {
    console.warn('[faststart] remux failed:', e?.message);
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// Best-effort: fast-start a File's video object and reconcile the stored size +
// owner quota with the new object size. Never throws, never alters content.
export async function optimizeFileVideo(fileId) {
  try {
    const file = await prisma.file.findUnique({ where: { id: fileId } });
    if (!file || !canFaststart(file.mimeType)) return;
    const newSize = await faststartRemux(file.objectKey, file.mimeType);
    if (newSize == null) return;

    const oldSize = BigInt(file.size);
    const delta = BigInt(newSize) - oldSize;
    await prisma.file.update({ where: { id: file.id }, data: { size: BigInt(newSize) } });
    if (delta !== 0n) {
      await prisma.user.update({
        where: { id: file.ownerId },
        data: { usedBytes: { increment: delta } },
      });
    }
  } catch (e) {
    console.warn('[faststart] optimizeFileVideo failed:', e?.message);
  }
}
