// K1 (OCR via tesseract) + K4 (semantic embeddings via transformers.js).
import { spawn } from 'node:child_process';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline as streamPipeline } from 'node:stream/promises';
import { getObjectStream } from './storage.service.js';
import { prisma } from '../config/prisma.js';
import { logger } from '../config/logger.js';
import { pgvectorEnabled, toVectorLiteral } from '../utils/vector.js';

const EMBED_MODEL = 'Xenova/all-MiniLM-L6-v2';
const OCR_LANGS = 'eng+vie';
const PDF_OCR_MAX_PAGES = 8;

export function canOcr(mime = '') {
  return mime.startsWith('image/') || mime === 'application/pdf';
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d.toString()));
    p.stderr.on('data', (d) => (err += d.toString()));
    p.on('error', reject);
    p.on('close', (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(`${cmd} exited ${code}: ${err.slice(0, 200)}`));
    });
  });
}

async function downloadTemp(objectKey, dir, name) {
  const p = join(dir, name);
  const src = await getObjectStream(objectKey);
  await streamPipeline(src, createWriteStream(p));
  return p;
}

// Extract text from an image or scanned PDF. Best-effort; returns '' on failure.
export async function ocrFromStorage(objectKey, mime) {
  const dir = await mkdtemp(join(tmpdir(), 'ocr-'));
  try {
    if (mime.startsWith('image/')) {
      const inPath = await downloadTemp(objectKey, dir, 'in.img');
      const text = await run('tesseract', [inPath, 'stdout', '-l', OCR_LANGS]);
      return text.trim();
    }
    if (mime === 'application/pdf') {
      const inPath = await downloadTemp(objectKey, dir, 'in.pdf');
      // Rasterize the first N pages, then OCR each.
      await run('pdftoppm', ['-png', '-r', '150', '-l', String(PDF_OCR_MAX_PAGES), inPath, join(dir, 'page')]);
      const pages = (await readdir(dir)).filter((f) => f.startsWith('page') && f.endsWith('.png')).sort();
      const parts = [];
      for (const pg of pages) {
        const t = await run('tesseract', [join(dir, pg), 'stdout', '-l', OCR_LANGS]).catch(() => '');
        if (t.trim()) parts.push(t.trim());
      }
      return parts.join('\n\n').trim();
    }
    return '';
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// ---- semantic embeddings (transformers.js, lazy-loaded) ----
let extractorPromise = null;
async function getExtractor() {
  if (!extractorPromise) {
    extractorPromise = import('@xenova/transformers').then(({ pipeline }) =>
      pipeline('feature-extraction', EMBED_MODEL),
    );
  }
  return extractorPromise;
}

export async function embed(text) {
  const clean = (text || '').slice(0, 4000).trim();
  if (!clean) return null;
  const extractor = await getExtractor();
  const output = await extractor(clean, { pooling: 'mean', normalize: true });
  return Array.from(output.data);
}

export function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot; // vectors are already L2-normalized
}

// Task5 #12 — mirror a freshly computed embedding into the pgvector column
// (PostgreSQL only; the JSON `embedding` string stays the portable source of
// truth). Best-effort like the rest of the indexing pipeline: never throws.
export async function syncVectorColumn(fileId, vector) {
  if (!pgvectorEnabled()) return;
  const lit = toVectorLiteral(vector);
  if (!lit) return;
  try {
    await prisma.$executeRaw`UPDATE "File" SET "embeddingVec" = ${lit}::vector WHERE "id" = ${fileId}`;
  } catch (e) {
    logger.warn({ err: e?.message, fileId }, '[ai] pgvector sync failed');
  }
}

// Index one file: OCR (if applicable) + embedding of name + ocrText. Best-effort.
export async function indexFile(fileId) {
  try {
    const file = await prisma.file.findUnique({
      where: { id: fileId },
      select: { id: true, name: true, mimeType: true, objectKey: true },
    });
    if (!file) return;

    let ocrText = null;
    if (canOcr(file.mimeType)) {
      ocrText = await ocrFromStorage(file.objectKey, file.mimeType).catch(() => '');
      if (ocrText) ocrText = ocrText.slice(0, 20000);
    }

    const basis = [file.name, ocrText].filter(Boolean).join('\n');
    const vector = await embed(basis).catch(() => null);

    await prisma.file.update({
      where: { id: file.id },
      data: {
        ...(ocrText != null ? { ocrText: ocrText || null } : {}),
        ...(vector ? { embedding: JSON.stringify(vector) } : {}),
      },
    });
    if (vector) await syncVectorColumn(file.id, vector);
  } catch (e) {
    logger.warn({ err: e?.message }, '[ai] indexFile failed');
  }
}
