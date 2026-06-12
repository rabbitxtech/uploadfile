// Task5 #10 — speech-to-text via whisper.cpp (CLI `whisper-cli`, installed in
// the Docker image; model ggml-<name>.bin downloaded lazily into the models
// cache volume on first use).
//
// For a video/audio file it:
//   1. extracts mono 16 kHz WAV audio with ffmpeg,
//   2. runs whisper-cli with -ovtt,
//   3. stores the transcript text in File.ocrText (+ refreshes the embedding)
//      so plain and semantic search cover spoken words,
//   4. uploads the .vtt as a SIBLING File in the same folder — the player's
//      existing same-basename subtitle matching (G2) picks it up with zero
//      frontend changes. The .vtt counts against the owner's quota (it's a
//      real, user-visible file); if quota is full the sibling is skipped but
//      the transcript still lands in ocrText.
//
// Best-effort and serialized (whisper is CPU-heavy): never throws into a
// request path, at most one transcription at a time.
import { spawn } from 'node:child_process';
import { createWriteStream, existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { env } from '../config/env.js';
import { prisma } from '../config/prisma.js';
import { logger } from '../config/logger.js';
import { getObjectStream, putObjectBuffer, objectKeyFor } from './storage.service.js';
import { addUsage } from './quota.service.js';
import { sha256Buffer } from './checksum.service.js';
import { embed, syncVectorColumn } from './ai.service.js';

const MODEL_BASE_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main';

export function canTranscribe(mime = '') {
  return mime.startsWith('video/') || mime.startsWith('audio/');
}

function modelPath() {
  const cache = process.env.TRANSFORMERS_CACHE || '/app/models';
  return join(cache, 'whisper', `ggml-${env.whisper.model}.bin`);
}

// Download the ggml model once (atomic rename so a crashed download never
// leaves a truncated model behind). Single inflight promise.
let modelPromise = null;
function ensureModel() {
  if (!modelPromise) {
    modelPromise = (async () => {
      const dest = modelPath();
      if (existsSync(dest)) return dest;
      await mkdir(dirname(dest), { recursive: true });
      const url = `${MODEL_BASE_URL}/ggml-${env.whisper.model}.bin`;
      logger.info({ url }, '[whisper] downloading model');
      const resp = await fetch(url);
      if (!resp.ok || !resp.body) throw new Error(`model download failed: ${resp.status}`);
      const tmp = dest + '.part';
      await pipeline(resp.body, createWriteStream(tmp));
      await rename(tmp, dest);
      logger.info({ dest }, '[whisper] model ready');
      return dest;
    })();
    modelPromise.catch(() => {
      modelPromise = null; // allow a retry on the next file
    });
  }
  return modelPromise;
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => (err += d.toString()));
    p.on('error', reject);
    p.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}: ${err.slice(-500)}`)),
    );
  });
}

// Strip WEBVTT headers/timestamps/cue settings down to the spoken text.
export function vttToText(vtt) {
  return vtt
    .split('\n')
    .filter(
      (line) =>
        line.trim() &&
        !/^WEBVTT/.test(line) &&
        !/^\d+$/.test(line.trim()) &&
        !/-->/u.test(line) &&
        !/^NOTE\b/.test(line),
    )
    .map((l) => l.replace(/<[^>]+>/g, '').trim())
    .join('\n')
    .trim();
}

async function transcribe(file) {
  const dir = await mkdtemp(join(tmpdir(), 'whisper-'));
  try {
    const inPath = join(dir, 'in.bin');
    const wavPath = join(dir, 'audio.wav');
    const outBase = join(dir, 'out');
    const src = await getObjectStream(file.objectKey);
    await pipeline(src, createWriteStream(inPath));

    // whisper.cpp wants mono 16 kHz PCM.
    await run('ffmpeg', ['-y', '-v', 'error', '-i', inPath, '-vn', '-ac', '1', '-ar', '16000', wavPath]);

    const model = await ensureModel();
    await run(env.whisper.bin, [
      '-m', model,
      '-f', wavPath,
      '-l', env.whisper.lang,
      '-ovtt',
      '-of', outBase,
      '-t', '4',
    ]);
    return readFile(outBase + '.vtt', 'utf8');
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// Store the .vtt next to the media file so the player's subtitle matching
// (same basename) finds it. Skipped if a same-named sibling already exists.
async function createVttSibling(file, vtt) {
  const name = file.name.replace(/\.[^.]+$/, '') + '.vtt';
  const exists = await prisma.file.findFirst({
    where: { ownerId: file.ownerId, folderId: file.folderId, name, trashedAt: null },
    select: { id: true },
  });
  if (exists) return;

  const buf = Buffer.from(vtt, 'utf8');
  const owner = await prisma.user.findUnique({ where: { id: file.ownerId } });
  if (!owner || BigInt(owner.usedBytes) + BigInt(buf.length) > BigInt(owner.quotaBytes)) {
    logger.warn({ fileId: file.id }, '[whisper] quota full — skipping .vtt sibling');
    return;
  }

  const key = objectKeyFor(file.ownerId, 'vtt');
  await putObjectBuffer(key, buf, 'text/vtt');
  const checksum = sha256Buffer(buf);
  await prisma.file.create({
    data: {
      name,
      originalName: name,
      mimeType: 'text/vtt',
      size: BigInt(buf.length),
      objectKey: key,
      bucket: process.env.MINIO_BUCKET || 'uploads',
      checksum,
      folderId: file.folderId,
      ownerId: file.ownerId,
      versions: { create: { version: 1, objectKey: key, size: BigInt(buf.length), checksum } },
    },
  });
  await addUsage(file.ownerId, buf.length);
}

// Serialize jobs — at most one whisper run at a time.
let queue = Promise.resolve();

// Transcribe a media file if the feature is enabled and it qualifies.
// Fire-and-forget safe.
export function maybeTranscribe(fileId) {
  if (!env.whisper.enabled) return;
  queue = queue.then(async () => {
    try {
      const file = await prisma.file.findUnique({ where: { id: fileId } });
      if (!file || file.trashedAt || !canTranscribe(file.mimeType)) return;
      if (file.ocrText) return; // already transcribed

      const started = Date.now();
      const vtt = await transcribe(file);
      const text = vttToText(vtt).slice(0, 20000);
      if (!text) return;

      const vector = await embed([file.name, text].join('\n')).catch(() => null);
      await prisma.file.update({
        where: { id: file.id },
        data: { ocrText: text, ...(vector ? { embedding: JSON.stringify(vector) } : {}) },
      });
      if (vector) await syncVectorColumn(file.id, vector);
      await createVttSibling(file, vtt);
      logger.info({ fileId: file.id, chars: text.length, ms: Date.now() - started }, '[whisper] transcribed');
    } catch (e) {
      logger.warn({ fileId, err: e?.message }, '[whisper] transcription failed');
    }
  });
}
