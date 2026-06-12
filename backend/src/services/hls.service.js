// Task5 #9 — background HLS transcode for adaptive video streaming.
//
// ffmpeg produces an h264/aac ladder (720p + 480p, capped at the source height)
// as 4s VOD segments in a flat layout:
//   h/<fileId>/master.m3u8, stream_0.m3u8, stream_0_00001.ts, stream_1.m3u8, …
// The playlists reference segments by bare filename, so serving everything from
// one URL directory (/api/files/:id/stream/hls/:name) resolves them naturally.
// Renditions are derived data (like thumbnails): they don't count against the
// owner's quota and are deleted alongside the file (removePrefix on hard-delete).
//
// Everything here is best-effort and never throws into a request path. Jobs are
// serialized through a module-level queue so concurrent uploads can't stack
// multiple ffmpeg transcodes on the CPU.
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { env } from '../config/env.js';
import { prisma } from '../config/prisma.js';
import { logger } from '../config/logger.js';
import { getObjectStream, putObjectBuffer, removePrefix } from './storage.service.js';

const HLS_MIMES = new Set([
  'video/mp4',
  'video/quicktime',
  'video/x-m4v',
  'video/webm',
  'video/x-matroska',
  'video/avi',
  'video/x-msvideo',
]);

// Bitrate ladder; rungs taller than the source are dropped.
const LADDER = [
  { height: 720, videoBitrate: '2800k', audioBitrate: '128k' },
  { height: 480, videoBitrate: '1200k', audioBitrate: '96k' },
];

export function canHls(mime) {
  return HLS_MIMES.has(mime);
}

export const hlsPrefix = (fileId) => `h/${fileId}/`;

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d.toString()));
    p.stderr.on('data', (d) => (err += d.toString()));
    p.on('error', reject);
    p.on('close', (code) =>
      code === 0 ? resolve(out) : reject(new Error(`${cmd} exited ${code}: ${err.slice(-500)}`)),
    );
  });
}

async function probe(inPath) {
  let height = 0;
  let hasAudio = false;
  try {
    const h = await run('ffprobe', [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=height',
      '-of', 'csv=p=0',
      inPath,
    ]);
    height = parseInt(h, 10) || 0;
  } catch {
    /* keep 0 */
  }
  try {
    const a = await run('ffprobe', [
      '-v', 'error',
      '-select_streams', 'a:0',
      '-show_entries', 'stream=codec_type',
      '-of', 'csv=p=0',
      inPath,
    ]);
    hasAudio = a.trim().length > 0;
  } catch {
    /* keep false */
  }
  return { height, hasAudio };
}

function contentTypeFor(name) {
  if (name.endsWith('.m3u8')) return 'application/vnd.apple.mpegurl';
  if (name.endsWith('.ts')) return 'video/mp2t';
  return 'application/octet-stream';
}

async function transcode(file) {
  const dir = await mkdtemp(join(tmpdir(), 'hls-'));
  const inPath = join(dir, 'in.bin');
  const outDir = join(dir, 'out');
  try {
    await mkdir(outDir); // ffmpeg won't create the segment directory itself
    const src = await getObjectStream(file.objectKey);
    await pipeline(src, createWriteStream(inPath));

    const { height, hasAudio } = await probe(inPath);
    let rungs = LADDER.filter((r) => height === 0 || r.height <= height);
    // Source shorter than the lowest rung → one rung at source height.
    if (rungs.length === 0) rungs = [{ height, videoBitrate: '800k', audioBitrate: '96k' }];

    await run('ffmpeg', ['-y', '-v', 'error', '-i', inPath, ...hlsArgs(rungs, hasAudio, outDir)]);

    // Upload every generated artifact under h/<fileId>/.
    const names = await readdir(outDir);
    for (const name of names) {
      const buf = await readFile(join(outDir, name));
      await putObjectBuffer(hlsPrefix(file.id) + name, buf, contentTypeFor(name));
    }
    return names.length;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// Build the single-pass multi-rendition ffmpeg argument list.
function hlsArgs(rungs, hasAudio, outDir) {
  const n = rungs.length;
  const split = `[0:v]split=${n}${rungs.map((_, i) => `[v${i}]`).join('')}`;
  // format=yuv420p: 4:4:4/10-bit sources break the h264 main profile and many
  // hardware decoders — force the universally supported pixel format.
  const scales = rungs.map((r, i) => `[v${i}]scale=-2:${r.height},format=yuv420p[v${i}out]`);
  const args = ['-filter_complex', [split, ...scales].join(';')];
  rungs.forEach((r, i) => {
    args.push(
      '-map', `[v${i}out]`,
      `-c:v:${i}`, 'libx264',
      '-preset', 'veryfast',
      `-b:v:${i}`, r.videoBitrate,
      '-profile:v', 'main',
      '-g', '48',
      '-sc_threshold', '0',
    );
  });
  if (hasAudio) {
    rungs.forEach((r, i) => {
      args.push('-map', '0:a:0', `-c:a:${i}`, 'aac', `-b:a:${i}`, r.audioBitrate, '-ac', '2');
    });
  }
  const varMap = rungs.map((_, i) => (hasAudio ? `v:${i},a:${i}` : `v:${i}`)).join(' ');
  args.push(
    '-f', 'hls',
    '-hls_time', '4',
    '-hls_playlist_type', 'vod',
    '-hls_segment_filename', join(outDir, 'stream_%v_%05d.ts'),
    '-master_pl_name', 'master.m3u8',
    '-var_stream_map', varMap,
    join(outDir, 'stream_%v.m3u8'),
  );
  return args;
}

// Serialize jobs — at most one ffmpeg transcode at a time.
let queue = Promise.resolve();

// Generate HLS renditions for a file if the feature is enabled and the file
// qualifies (video mime, big enough, not already done). Fire-and-forget safe.
export function maybeGenerateHls(fileId) {
  if (!env.hls.enabled) return;
  queue = queue.then(async () => {
    try {
      const file = await prisma.file.findUnique({ where: { id: fileId } });
      if (!file || file.trashedAt || file.hlsReady) return;
      if (!canHls(file.mimeType)) return;
      if (BigInt(file.size) < BigInt(env.hls.minBytes)) return;

      const started = Date.now();
      const artifacts = await transcode(file);
      await prisma.file.update({ where: { id: file.id }, data: { hlsReady: true } });
      logger.info(
        { fileId: file.id, artifacts, ms: Date.now() - started },
        '[hls] renditions ready',
      );
    } catch (e) {
      logger.warn({ fileId, err: e?.message }, '[hls] transcode failed');
    }
  });
}

// Drop a file's renditions (hard delete / new version replaces content).
export async function removeHls(fileId) {
  try {
    await removePrefix(hlsPrefix(fileId));
  } catch (e) {
    logger.warn({ fileId, err: e?.message }, '[hls] cleanup failed');
  }
}
