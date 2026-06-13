// Files CRUD, single-shot upload (multer), download, preview, versioning,
// tags, search, move, and bulk-zip download.
import { assertUrlAllowed } from '../utils/ssrf.js';
import fs from 'node:fs';
import { Router } from 'express';
import jwt from 'jsonwebtoken';
import multer from 'multer';
import archiver from 'archiver';
import { z } from 'zod';
import { prisma } from '../config/prisma.js';
import { env } from '../config/env.js';
import { requireAuth, requireApproved } from '../middleware/auth.js';
import { asyncHandler } from '../utils/async.js';
import { badRequest, notFound, unauthorized, forbidden, HttpError } from '../utils/errors.js';
import { makeThrottle } from '../utils/throttle.js';
import {
  getObjectStream,
  getObjectRange,
  objectKeyFor,
  presignedGet,
  putObjectStream,
  removeObject,
} from '../services/storage.service.js';
import { addUsage, assertQuota } from '../services/quota.service.js';
import { canThumbnail, generateThumbnail } from '../services/thumbnail.service.js';
import {
  canFaststart,
  optimizeFileVideo,
  canVideoThumbnail,
  generateVideoThumbnail,
} from '../services/video.service.js';
import { fileAccessLevel, canEdit } from '../services/access.service.js';
import { postProcessMedia } from '../services/media.service.js';
import { maybeGenerateHls, removeHls, hlsPrefix } from '../services/hls.service.js';
import { maybeTranscribe } from '../services/transcribe.service.js';
import { notify } from '../services/notify.service.js';
import { emitFileChange } from '../realtime/bus.js';
import { sha256Buffer, backfillChecksum } from '../services/checksum.service.js';
import { indexFile, embed, cosine } from '../services/ai.service.js';
import { pgvectorEnabled, toVectorLiteral } from '../utils/vector.js';
import { downloadYoutube, isAllowedSource, SUPPORTED_SOURCES, mimeForExt } from '../services/youtube.service.js';

const router = Router();
const STREAM_EXPIRY = '3h';
const STREAM_MAX_AGE_MS = 3 * 60 * 60 * 1000; // keep in sync with STREAM_EXPIRY
const STREAM_COOKIE = 'stream_tkn';

// Read a single cookie value from the raw header (avoids a cookie-parser dep).
function readCookie(req, name) {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

// Authenticated media streaming (better source protection than a raw presigned
// MinIO URL): the object never leaves our backend, and every request re-checks
// access. The stream credential is a short-lived, file+user-bound JWT delivered
// as an HttpOnly+Secure+SameSite cookie (NOT in the URL) so a plain <video src>
// works without an Authorization header while staying unshareable and invisible
// to JS/logs/history. Supports HTTP Range for seeking. This route is mounted
// BEFORE requireAuth — it does its own token auth — so it must come first.
// Validate the stream cookie for /:id/stream and /:id/stream/hls/* — both are
// mounted before requireAuth and authenticate via the HttpOnly cookie instead
// (browsers can't set Authorization on <video src> / hls.js segment requests).
async function streamAuth(req) {
  const token = readCookie(req, STREAM_COOKIE);
  if (!token) throw unauthorized('Missing stream credential');
  let payload;
  try {
    payload = jwt.verify(token, env.jwtSecret);
  } catch {
    throw unauthorized('Invalid or expired stream token');
  }
  if (payload.p !== 'stream' || payload.fid !== req.params.id) throw unauthorized('Invalid stream token');

  const user = await prisma.user.findUnique({ where: { id: payload.sub } });
  if (!user || user.banned) throw forbidden('No access');
  const file = await prisma.file.findFirst({ where: { id: req.params.id, trashedAt: null } });
  if (!file) throw notFound('File');
  const level = await fileAccessLevel(user, file);
  if (!level) throw notFound('File'); // access revoked since the token was issued
  return file;
}

router.get(
  '/:id/stream',
  asyncHandler(async (req, res) => {
    const file = await streamAuth(req);

    const size = Number(file.size);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Type', file.mimeType);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(file.name)}"`);

    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      let start = m && m[1] ? parseInt(m[1], 10) : 0;
      let end = m && m[2] ? parseInt(m[2], 10) : size - 1;
      if (Number.isNaN(start) || start < 0) start = 0;
      if (Number.isNaN(end) || end >= size) end = size - 1;
      if (start > end) {
        res.status(416).setHeader('Content-Range', `bytes */${size}`);
        return res.end();
      }
      const chunkLen = end - start + 1;
      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
      res.setHeader('Content-Length', chunkLen);
      const stream = await getObjectRange(file.objectKey, start, chunkLen);
      stream.on('error', () => res.destroy());
      stream.pipe(res);
    } else {
      res.setHeader('Content-Length', size);
      const stream = await getObjectStream(file.objectKey);
      stream.on('error', () => res.destroy());
      stream.pipe(res);
    }
    bumpAccessed(file.id);
  }),
);

// Task5 #9 — HLS playlists + segments (h/<fileId>/<name> in MinIO), protected
// by the same stream cookie: its path (/api/files/<id>/stream) covers this
// subpath, so hls.js requests carry it automatically. Flat layout — playlists
// reference segments by bare filename, all served from this one directory.
router.get(
  '/:id/stream/hls/:name',
  asyncHandler(async (req, res) => {
    const file = await streamAuth(req);
    const { name } = req.params;
    if (!file.hlsReady || !/^[A-Za-z0-9_-]+\.(m3u8|ts)$/.test(name)) throw notFound('File');

    res.setHeader(
      'Content-Type',
      name.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t',
    );
    res.setHeader('Cache-Control', 'private, max-age=3600');
    const stream = await getObjectStream(hlsPrefix(file.id) + name);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  }),
);

router.use(requireAuth);

// Case-insensitive `contains`. Prisma's `mode: 'insensitive'` is PostgreSQL-only;
// MySQL is already case-insensitive by collation, and SQLite LIKE is too — so we
// only attach the mode for Postgres and let the others rely on collation.
const PG = (process.env.DB_PROVIDER || 'postgresql') === 'postgresql';
const ciContains = (q) => (PG ? { contains: q, mode: 'insensitive' } : { contains: q });

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });

// Single-shot upload (for small files; large files use /api/upload chunked flow)
router.post(
  '/',
  requireApproved,
  upload.single('file'),
  asyncHandler(async (req, res) => {
    if (!req.file) throw badRequest('No file uploaded');
    const folderId = req.body.folderId || null;
    if (folderId) {
      const f = await prisma.folder.findFirst({
        where: { id: folderId, ownerId: req.user.id, trashedAt: null },
      });
      if (!f) throw notFound('Folder');
    }
    await assertQuota(req.user.id, req.file.size);

    const ext = req.file.originalname.includes('.') ? req.file.originalname.split('.').pop() : '';
    const key = objectKeyFor(req.user.id, ext);
    await putObjectStream(key, req.file.buffer, req.file.size, req.file.mimetype);
    const checksum = sha256Buffer(req.file.buffer);

    const file = await prisma.file.create({
      data: {
        name: req.file.originalname,
        originalName: req.file.originalname,
        mimeType: req.file.mimetype,
        size: BigInt(req.file.size),
        objectKey: key,
        bucket: process.env.MINIO_BUCKET || 'uploads',
        checksum,
        folderId,
        ownerId: req.user.id,
        versions: {
          create: { version: 1, objectKey: key, size: BigInt(req.file.size), checksum },
        },
      },
      include: { tags: true, versions: true },
    });

    await addUsage(req.user.id, req.file.size);

    if (canThumbnail(req.file.mimetype)) {
      generateThumbnail(key, req.file.mimetype)
        .then((thumbKey) => {
          if (thumbKey) {
            return prisma.file.update({
              where: { id: file.id },
              data: { thumbnailKey: thumbKey, hasPreview: true },
            });
          }
        })
        .catch((e) => console.warn('[thumb] failed:', e?.message));
    } else if (canVideoThumbnail(req.file.mimetype)) {
      makeVideoThumb(file.id, key, req.file.mimetype);
    }

    postProcessMedia(file.id, req.file.mimetype); // faststart → HLS + transcribe
    indexFile(file.id); // K1/K4 — OCR + embedding (async, best-effort)
    emitFileChange(req.user.id, folderId); // Task5 #5 — live-refresh other tabs/devices

    res.status(201).json(file);
  }),
);

// Generate a video poster thumbnail (best-effort, async).
function makeVideoThumb(fileId, objectKey, mimeType) {
  generateVideoThumbnail(objectKey, mimeType)
    .then((thumbKey) => {
      if (thumbKey) {
        return prisma.file.update({
          where: { id: fileId },
          data: { thumbnailKey: thumbKey, hasPreview: true },
        });
      }
    })
    .catch((e) => console.warn('[vthumb] failed:', e?.message));
}

// Bump File.accessedAt asynchronously (best-effort, no await).
function bumpAccessed(id) {
  prisma.file.updateMany({ where: { id }, data: { accessedAt: new Date() } }).catch(() => {});
}

// Fetch a file the user is allowed to read (owner, admin, or granted via
// file/folder share). Returns { file, level } — file is null if no access.
async function readableFile(req, include) {
  const file = await prisma.file.findUnique({ where: { id: req.params.id }, include });
  if (!file) return { file: null, level: null };
  const level = await fileAccessLevel(req.user, file);
  if (!level) return { file: null, level: null };
  return { file, level };
}

// Prisma where-filter for write operations: admins act on ANY file/folder,
// regular users are scoped to what they own.
function ownedWhere(req, id) {
  if (req.user.role === 'admin') return { id };
  return { id, ownerId: req.user.id };
}
function ownerScope(req) {
  return req.user.role === 'admin' ? {} : { ownerId: req.user.id };
}

// Recently accessed files (preview/download/url touch)
router.get(
  '/recent',
  asyncHandler(async (req, res) => {
    const files = await prisma.file.findMany({
      where: { ownerId: req.user.id, trashedAt: null, accessedAt: { not: null } },
      orderBy: { accessedAt: 'desc' },
      take: 50,
      include: { tags: true, folder: true, owner: { select: { id: true, name: true, email: true } } },
    });
    res.json({ files });
  }),
);

// Starred files
router.get(
  '/starred',
  asyncHandler(async (req, res) => {
    const files = await prisma.file.findMany({
      where: { ownerId: req.user.id, trashedAt: null, starred: true },
      orderBy: { updatedAt: 'desc' },
      include: { tags: true, folder: true, owner: { select: { id: true, name: true, email: true } } },
    });
    res.json({ files });
  }),
);

// Storage analytics — aggregate the caller's files (admin may pass ?ownerId).
// Returns: totals, breakdown by media category, largest files, top folders.
function mimeCategory(mime = '') {
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime === 'application/pdf') return 'pdf';
  if (mime.startsWith('text/')) return 'document';
  if (/(word|excel|powerpoint|spreadsheet|presentation|document|officedocument)/.test(mime))
    return 'document';
  if (/(zip|rar|7z|tar|gzip|compressed)/.test(mime)) return 'archive';
  return 'other';
}

router.get(
  '/analytics',
  asyncHandler(async (req, res) => {
    const ownerId =
      req.user.role === 'admin' && req.query.ownerId ? String(req.query.ownerId) : req.user.id;

    const [files, owner] = await Promise.all([
      prisma.file.findMany({
        where: { ownerId, trashedAt: null },
        select: {
          id: true,
          name: true,
          size: true,
          mimeType: true,
          createdAt: true,
          folder: { select: { id: true, name: true, path: true } },
        },
      }),
      prisma.user.findUnique({
        where: { id: ownerId },
        select: { quotaBytes: true, usedBytes: true },
      }),
    ]);

    const byCategory = {};
    const byFolder = {};
    let totalSize = 0n;

    for (const f of files) {
      const size = BigInt(f.size || 0);
      totalSize += size;
      const cat = mimeCategory(f.mimeType || '');
      const c = (byCategory[cat] ||= { category: cat, count: 0, size: 0n });
      c.count += 1;
      c.size += size;

      const key = f.folder ? f.folder.id : 'root';
      const fld = (byFolder[key] ||= {
        id: f.folder?.id || null,
        name: f.folder?.name || 'Home',
        path: f.folder?.path || '/',
        count: 0,
        size: 0n,
      });
      fld.count += 1;
      fld.size += size;
    }

    const largest = [...files]
      .sort((a, b) => (BigInt(b.size || 0) > BigInt(a.size || 0) ? 1 : -1))
      .slice(0, 10)
      .map((f) => ({
        id: f.id,
        name: f.name,
        size: f.size,
        mimeType: f.mimeType,
        category: mimeCategory(f.mimeType || ''),
        folder: f.folder ? { id: f.folder.id, name: f.folder.name } : null,
      }));

    res.json({
      totalFiles: files.length,
      totalSize: totalSize.toString(),
      quotaBytes: owner?.quotaBytes ?? null,
      usedBytes: owner?.usedBytes ?? null,
      byCategory: Object.values(byCategory)
        .map((c) => ({ ...c, size: c.size.toString() }))
        .sort((a, b) => (BigInt(b.size) > BigInt(a.size) ? 1 : -1)),
      byFolder: Object.values(byFolder)
        .map((f) => ({ ...f, size: f.size.toString() }))
        .sort((a, b) => (BigInt(b.size) > BigInt(a.size) ? 1 : -1))
        .slice(0, 10),
      largest,
    });
  }),
);

// H2 — duplicate detection. Groups the caller's non-trashed files by checksum,
// returning only groups with more than one file (admin may pass ?ownerId).
router.get(
  '/duplicates',
  asyncHandler(async (req, res) => {
    const ownerId =
      req.user.role === 'admin' && req.query.ownerId ? String(req.query.ownerId) : req.user.id;

    const files = await prisma.file.findMany({
      where: { ownerId, trashedAt: null, checksum: { not: null } },
      select: {
        id: true,
        name: true,
        size: true,
        mimeType: true,
        checksum: true,
        createdAt: true,
        folder: { select: { id: true, name: true, path: true } },
      },
      orderBy: { createdAt: 'asc' },
    });

    const map = new Map();
    for (const f of files) {
      if (!map.has(f.checksum)) map.set(f.checksum, []);
      map.get(f.checksum).push(f);
    }
    const groups = [...map.values()]
      .filter((g) => g.length > 1)
      .map((g) => ({
        checksum: g[0].checksum,
        count: g.length,
        size: g[0].size, // identical content → same size
        wastedBytes: (BigInt(g[0].size) * BigInt(g.length - 1)).toString(),
        files: g,
      }))
      .sort((a, b) => (BigInt(b.wastedBytes) > BigInt(a.wastedBytes) ? 1 : -1));

    const wasted = groups.reduce((n, g) => n + BigInt(g.wastedBytes), 0n);
    res.json({ groups, totalGroups: groups.length, wastedBytes: wasted.toString() });
  }),
);

// Import a file from a remote URL — server fetches and stores it in MinIO.
const fromUrlSchema = z.object({
  url: z.string().url(),
  folderId: z.string().optional().nullable(),
});

const URL_FETCH_MAX = 500 * 1024 * 1024; // hard cap regardless of quota

// SSRF guard lives in utils/ssrf.js (shared with push subscribe).

// Fetch a URL while manually following redirects so EACH hop is re-validated by
// the SSRF guard — otherwise a public URL could 30x-redirect to an internal
// host (cloud metadata, localhost, etc.) and bypass the initial check.
async function fetchFollowingSafely(initialUrl, signal, maxHops = 5) {
  let url = initialUrl;
  for (let hop = 0; hop <= maxHops; hop++) {
    await assertUrlAllowed(url);
    const resp = await fetch(url, { signal, redirect: 'manual' });
    if (resp.status >= 300 && resp.status < 400 && resp.headers.get('location')) {
      url = new URL(resp.headers.get('location'), url).toString();
      continue; // re-validate the next hop before fetching it
    }
    return resp;
  }
  throw badRequest('Too many redirects');
}

function filenameFromUrl(u, contentType) {
  let name = '';
  try {
    const p = decodeURIComponent(new URL(u).pathname);
    name = p.split('/').filter(Boolean).pop() || '';
  } catch {
    name = '';
  }
  name = name.split('?')[0].split('#')[0];
  if (!name) name = 'download';
  if (!name.includes('.')) {
    const ext = (contentType || '').split('/')[1]?.split(';')[0]?.replace(/[^a-z0-9]/gi, '');
    if (ext) name = `${name}.${ext}`;
  }
  return name.slice(0, 255);
}

router.post(
  '/from-url',
  requireApproved,
  asyncHandler(async (req, res) => {
    const { url, folderId } = fromUrlSchema.parse(req.body);

    // Validate the initial URL up front for a fast, clear 400 (each redirect hop
    // is re-validated inside fetchFollowingSafely).
    await assertUrlAllowed(url);

    if (folderId) {
      const f = await prisma.folder.findFirst({
        where: { id: folderId, ownerId: req.user.id, trashedAt: null },
      });
      if (!f) throw notFound('Folder');
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60_000);
    let resp;
    try {
      resp = await fetchFollowingSafely(url, controller.signal);
    } catch (e) {
      clearTimeout(timeout);
      if (e instanceof HttpError) throw e; // blocked-host / redirect-limit → keep the 400
      throw badRequest(`Could not fetch URL: ${e?.message || 'network error'}`);
    }
    if (!resp.ok || !resp.body) {
      clearTimeout(timeout);
      throw badRequest(`Remote returned ${resp.status}`);
    }

    const declared = Number(resp.headers.get('content-length') || 0);
    if (declared && declared > URL_FETCH_MAX) {
      clearTimeout(timeout);
      throw badRequest('Remote file is too large');
    }
    if (declared) await assertQuota(req.user.id, declared);

    // Stream into a buffer with a running size cap.
    const chunks = [];
    let total = 0;
    try {
      for await (const chunk of resp.body) {
        total += chunk.length;
        if (total > URL_FETCH_MAX) throw badRequest('Remote file is too large');
        chunks.push(chunk);
      }
    } finally {
      clearTimeout(timeout);
    }
    const buffer = Buffer.concat(chunks, total);
    await assertQuota(req.user.id, total); // verify against actual size

    const contentType = (resp.headers.get('content-type') || 'application/octet-stream')
      .split(';')[0]
      .trim();
    const name = filenameFromUrl(url, contentType);
    const ext = name.includes('.') ? name.split('.').pop() : '';
    const key = objectKeyFor(req.user.id, ext);
    await putObjectStream(key, buffer, total, contentType);
    const checksum = sha256Buffer(buffer);

    const file = await prisma.file.create({
      data: {
        name,
        originalName: name,
        mimeType: contentType,
        size: BigInt(total),
        objectKey: key,
        bucket: process.env.MINIO_BUCKET || 'uploads',
        checksum,
        folderId: folderId || null,
        ownerId: req.user.id,
        versions: { create: { version: 1, objectKey: key, size: BigInt(total), checksum } },
      },
      include: { tags: true, versions: true },
    });

    await addUsage(req.user.id, total);

    if (canThumbnail(contentType)) {
      generateThumbnail(key, contentType)
        .then((thumbKey) => {
          if (thumbKey)
            return prisma.file.update({
              where: { id: file.id },
              data: { thumbnailKey: thumbKey, hasPreview: true },
            });
        })
        .catch((e) => console.warn('[thumb] failed:', e?.message));
    } else if (canVideoThumbnail(contentType)) {
      makeVideoThumb(file.id, key, contentType);
    }
    postProcessMedia(file.id, contentType); // faststart → HLS + transcribe
    indexFile(file.id); // K1/K4
    emitFileChange(req.user.id, folderId || null);

    res.status(201).json(file);
  }),
);

// Import a video from YouTube via yt-dlp (best quality, no length cap). The CLI
// downloads to a temp dir; we stream the result into MinIO, then clean up. The
// response is a stream of newline-delimited JSON (NDJSON) progress events so the
// browser can show a live progress bar — { type:'progress'|'status'|'done'|
// 'error', ... }. nginx has a dedicated long-timeout, unbuffered location for it.
router.post(
  '/from-youtube',
  requireApproved,
  asyncHandler(async (req, res) => {
    // Validation runs BEFORE we start streaming, so these throw normal JSON 4xx.
    const { url, folderId } = z
      .object({ url: z.string().url(), folderId: z.string().optional().nullable() })
      .parse(req.body);
    if (!isAllowedSource(url)) throw badRequest(`Unsupported source. Supported: ${SUPPORTED_SOURCES}`);
    if (folderId) {
      const f = await prisma.folder.findFirst({
        where: { id: folderId, ownerId: req.user.id, trashedAt: null },
      });
      if (!f) throw notFound('Folder');
    }

    // Switch to NDJSON streaming. After this point we never throw past the
    // handler (headers are already sent) — errors are emitted as events.
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Accel-Buffering', 'no'); // tell nginx not to buffer this response
    res.flushHeaders?.();
    const send = (obj) => {
      try {
        res.write(JSON.stringify(obj) + '\n');
      } catch {
        /* client gone */
      }
    };
    send({ type: 'status', status: 'starting' });

    let dl;
    try {
      dl = await downloadYoutube(url, send);
    } catch (e) {
      send({ type: 'error', error: `YouTube download failed: ${e?.message || 'unknown error'}` });
      return res.end();
    }

    // Track the uploaded object so we can clean it up if the DB row never gets
    // created — otherwise a mid-flow failure leaves an orphan in MinIO that no
    // File row (and no quota charge) ever accounts for.
    let uploadedKey = null;
    let committed = false;
    try {
      const total = dl.size;
      try {
        await assertQuota(req.user.id, total); // 413 if the video exceeds quota
      } catch (e) {
        send({ type: 'error', error: e?.message || 'Quota exceeded' });
        return res.end();
      }

      send({ type: 'status', status: 'uploading' });
      const mimeType = mimeForExt(dl.ext);
      const key = objectKeyFor(req.user.id, dl.ext);
      uploadedKey = key;
      await putObjectStream(key, fs.createReadStream(dl.filePath), total, mimeType);

      const file = await prisma.file.create({
        data: {
          name: dl.name,
          originalName: dl.name,
          mimeType,
          size: BigInt(total),
          objectKey: key,
          bucket: process.env.MINIO_BUCKET || 'uploads',
          folderId: folderId || null,
          ownerId: req.user.id,
          versions: { create: { version: 1, objectKey: key, size: BigInt(total) } },
        },
        include: { tags: true, versions: true },
      });
      committed = true;

      await addUsage(req.user.id, total);
      backfillChecksum(file.id, key); // dedup checksum (async, streams from MinIO)
      if (canVideoThumbnail(mimeType)) makeVideoThumb(file.id, key, mimeType);
      postProcessMedia(file.id, mimeType); // faststart → HLS + transcribe
      indexFile(file.id); // K1/K4
      emitFileChange(req.user.id, folderId || null);

      send({ type: 'done', file });
    } catch (e) {
      if (uploadedKey && !committed) removeObject(uploadedKey).catch(() => {}); // drop the orphan
      send({ type: 'error', error: e?.message || 'Import failed' });
    } finally {
      dl.cleanup();
      res.end();
    }
  }),
);

// Toggle star
router.post(
  '/:id/star',
  asyncHandler(async (req, res) => {
    const file = await prisma.file.findFirst({ where: ownedWhere(req, req.params.id) });
    if (!file) throw notFound('File');
    const updated = await prisma.file.update({
      where: { id: file.id },
      data: { starred: !file.starred },
    });
    res.json({ id: updated.id, starred: updated.starred });
  }),
);

// Fast-start an existing video (lossless container rewrite — moov to front).
// Non-destructive: never changes the video's length or content.
router.post(
  '/:id/optimize',
  asyncHandler(async (req, res) => {
    const file = await prisma.file.findFirst({ where: ownedWhere(req, req.params.id) });
    if (!file) throw notFound('File');
    if (!canFaststart(file.mimeType)) throw badRequest('Not an optimizable video');
    await optimizeFileVideo(file.id);
    // Backfill a poster thumbnail for videos uploaded before thumbnails existed.
    if (!file.thumbnailKey && canVideoThumbnail(file.mimeType)) {
      makeVideoThumb(file.id, file.objectKey, file.mimeType);
    }
    // Backfill HLS renditions / transcript for videos uploaded before Task5.
    maybeGenerateHls(file.id);
    maybeTranscribe(file.id);
    const updated = await prisma.file.findUnique({ where: { id: file.id } });
    res.json({ id: updated.id, size: updated.size.toString() });
  }),
);

// Search by name / tag
router.get(
  '/search',
  asyncHandler(async (req, res) => {
    const q = String(req.query.q || '').trim();
    const tag = req.query.tag ? String(req.query.tag) : null;
    if (!q && !tag) return res.json({ files: [] });

    const files = await prisma.file.findMany({
      where: {
        ownerId: req.user.id,
        trashedAt: null,
        AND: [
          // K1 — match the file name OR its OCR-extracted text (case-insensitive).
          q ? { OR: [{ name: ciContains(q) }, { ocrText: ciContains(q) }] } : {},
          tag ? { tags: { some: { name: tag } } } : {},
        ],
      },
      include: {
        tags: true,
        folder: true,
        owner: { select: { id: true, name: true, email: true } },
      },
      orderBy: { updatedAt: 'desc' },
      take: 100,
    });
    res.json({ files });
  }),
);

// K4 — semantic search: embed the query and rank files by cosine similarity.
// Task5 #12 — on PostgreSQL the ranking runs in the database against the
// pgvector `embeddingVec` column (HNSW index: `ORDER BY <=> LIMIT 30` is an
// ANN index scan, no full load into Node). mysql/sqlite keep the JS fallback.
router.get(
  '/semantic-search',
  asyncHandler(async (req, res) => {
    const q = String(req.query.q || '').trim();
    if (!q) return res.json({ files: [] });
    const qvec = await embed(q).catch(() => null);
    if (!qvec) return res.json({ files: [], error: 'Embedding unavailable' });

    const lit = pgvectorEnabled() ? toVectorLiteral(qvec) : null;
    if (lit) {
      // Pure ORDER BY … LIMIT keeps the HNSW index scan; the score floor is
      // applied afterwards in JS so it can't break the index usage.
      const hits = (
        await prisma.$queryRaw`
          SELECT "id", 1 - ("embeddingVec" <=> ${lit}::vector) AS score
          FROM "File"
          WHERE "ownerId" = ${req.user.id} AND "trashedAt" IS NULL AND "embeddingVec" IS NOT NULL
          ORDER BY "embeddingVec" <=> ${lit}::vector
          LIMIT 30`
      ).filter((h) => Number(h.score) > 0.2);
      if (!hits.length) return res.json({ files: [] });
      const rows = await prisma.file.findMany({
        where: { id: { in: hits.map((h) => h.id) } },
        include: { tags: true, folder: true, owner: { select: { id: true, name: true, email: true } } },
      });
      const byId = new Map(rows.map((f) => [f.id, f]));
      return res.json({
        files: hits.flatMap((h) => {
          const f = byId.get(h.id);
          if (!f) return [];
          const { embedding, ocrText, ...rest } = f;
          return [{ ...rest, score: Number(Number(h.score).toFixed(3)) }];
        }),
      });
    }

    const files = await prisma.file.findMany({
      where: { ownerId: req.user.id, trashedAt: null, embedding: { not: null } },
      include: { tags: true, folder: true, owner: { select: { id: true, name: true, email: true } } },
    });
    const ranked = files
      .map((f) => {
        let v = null;
        try {
          v = JSON.parse(f.embedding);
        } catch {
          v = null;
        }
        const { embedding, ocrText, ...rest } = f;
        return { file: rest, score: cosine(qvec, v) };
      })
      .filter((x) => x.score > 0.2)
      .sort((a, b) => b.score - a.score)
      .slice(0, 30);
    res.json({ files: ranked.map((x) => ({ ...x.file, score: Number(x.score.toFixed(3)) })) });
  }),
);

// K1/K4 — (re)index existing files that have no embedding yet (background).
router.post(
  '/reindex',
  asyncHandler(async (req, res) => {
    const files = await prisma.file.findMany({
      where: { ownerId: req.user.id, trashedAt: null, embedding: null },
      select: { id: true },
      take: 1000,
    });
    (async () => {
      for (const f of files) await indexFile(f.id);
    })().catch(() => {});
    res.json({ queued: files.length });
  }),
);

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const { file, level } = await readableFile(req, {
      tags: true,
      versions: { orderBy: { version: 'desc' } },
      folder: true,
      owner: { select: { id: true, name: true, email: true } },
    });
    if (!file) throw notFound('File');
    res.json({ ...file, accessLevel: level, canEdit: canEdit(level) });
  }),
);

// Stream file content (proxied through API; for big downloads use /url)
router.get(
  '/:id/download',
  asyncHandler(async (req, res) => {
    const versionNum = req.query.version ? parseInt(String(req.query.version), 10) : null;
    const { file } = await readableFile(req, { versions: true });
    if (!file) throw notFound('File');
    const v = versionNum
      ? file.versions.find((x) => x.version === versionNum)
      : { objectKey: file.objectKey };
    if (!v) throw notFound('Version');

    res.setHeader('Content-Type', file.mimeType);
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(file.name)}"`);
    const stream = await getObjectStream(v.objectKey);
    stream.on('error', (e) => res.destroy(e));
    // Task 15 — optional per-connection bandwidth cap (0 = unlimited).
    const throttle = makeThrottle(env.limits.downloadKbps);
    if (throttle) {
      throttle.on('error', (e) => res.destroy(e));
      stream.pipe(throttle).pipe(res);
    } else {
      stream.pipe(res);
    }
    bumpAccessed(file.id);
  }),
);

// Presigned URL for direct browser download/preview from MinIO.
// ?inline=1 omits Content-Disposition: attachment so the URL renders inline
// in <img>/<video>/<iframe>; default (no param) forces download.
//
// Inline URLs get a long expiry (6h) because they back in-browser media
// playback: a long video or seeking after a pause would otherwise hit a 403
// when the short-lived signature expires mid-stream. Download URLs stay short.
const INLINE_EXPIRY = 6 * 60 * 60; // 6 hours
const DOWNLOAD_EXPIRY = 10 * 60; // 10 minutes
router.get(
  '/:id/url',
  asyncHandler(async (req, res) => {
    const { file } = await readableFile(req);
    if (!file) throw notFound('File');
    const inline = req.query.inline === '1' || req.query.inline === 'true';
    const expiresIn = inline ? INLINE_EXPIRY : DOWNLOAD_EXPIRY;
    const url = await presignedGet(file.objectKey, expiresIn, inline ? undefined : file.name);
    res.json({ url, expiresIn });
    bumpAccessed(file.id);
  }),
);

// Issue a short-lived token to stream this file via /:id/stream (video source
// protection — keeps the object behind our auth instead of a presigned URL).
router.get(
  '/:id/stream-token',
  asyncHandler(async (req, res) => {
    const { file } = await readableFile(req);
    if (!file) throw notFound('File');
    const token = jwt.sign({ sub: req.user.id, fid: file.id, p: 'stream' }, env.jwtSecret, {
      expiresIn: STREAM_EXPIRY,
    });
    // Deliver the credential as a hardened cookie scoped to this file's stream
    // path — never in the URL. Secure only in prod (dev runs over plain HTTP).
    res.cookie(STREAM_COOKIE, token, {
      httpOnly: true,
      secure: env.nodeEnv === 'production',
      sameSite: 'strict',
      path: `/api/files/${file.id}/stream`,
      maxAge: STREAM_MAX_AGE_MS,
    });
    res.json({ ok: true });
  }),
);

// Inline preview stream (for in-browser viewers)
router.get(
  '/:id/preview',
  asyncHandler(async (req, res) => {
    const { file } = await readableFile(req);
    if (!file) throw notFound('File');
    res.setHeader('Content-Type', file.mimeType);
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(file.name)}"`);
    const stream = await getObjectStream(file.objectKey);
    stream.on('error', (e) => res.destroy(e));
    stream.pipe(res);
    bumpAccessed(file.id);
  }),
);

// ---- Watch progress (per-user, synced across devices) ----
// Read access to the file is required; progress is keyed to the current user.
router.get(
  '/:id/progress',
  asyncHandler(async (req, res) => {
    const { file } = await readableFile(req);
    if (!file) throw notFound('File');
    const p = await prisma.watchProgress.findUnique({
      where: { userId_fileId: { userId: req.user.id, fileId: file.id } },
    });
    res.json(p ? { position: p.position, duration: p.duration, updatedAt: p.updatedAt } : { position: 0 });
  }),
);

router.put(
  '/:id/progress',
  asyncHandler(async (req, res) => {
    const data = z
      .object({
        position: z.coerce.number().int().min(0),
        duration: z.coerce.number().int().min(0).optional(),
      })
      .parse(req.body);
    const { file } = await readableFile(req);
    if (!file) throw notFound('File');

    // Clear the row entirely once the video is essentially finished.
    if (data.duration && data.position >= data.duration - 10) {
      await prisma.watchProgress
        .delete({ where: { userId_fileId: { userId: req.user.id, fileId: file.id } } })
        .catch(() => {});
      return res.json({ ok: true, cleared: true });
    }

    await prisma.watchProgress.upsert({
      where: { userId_fileId: { userId: req.user.id, fileId: file.id } },
      update: { position: data.position, duration: data.duration ?? undefined },
      create: {
        userId: req.user.id,
        fileId: file.id,
        position: data.position,
        duration: data.duration ?? null,
      },
    });
    res.json({ ok: true });
  }),
);

router.delete(
  '/:id/progress',
  asyncHandler(async (req, res) => {
    await prisma.watchProgress
      .delete({ where: { userId_fileId: { userId: req.user.id, fileId: req.params.id } } })
      .catch(() => {});
    res.json({ ok: true });
  }),
);

// Thumbnail stream
router.get(
  '/:id/thumbnail',
  asyncHandler(async (req, res) => {
    const { file } = await readableFile(req);
    if (!file || !file.thumbnailKey) throw notFound('Thumbnail');
    res.setHeader('Content-Type', 'image/webp');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    const stream = await getObjectStream(file.thumbnailKey);
    stream.on('error', (e) => res.destroy(e));
    stream.pipe(res);
  }),
);

router.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const data = z
      .object({
        name: z.string().min(1).max(512).optional(),
        folderId: z.string().nullable().optional(),
        tags: z.array(z.string()).optional(),
      })
      .parse(req.body);

    const file = await prisma.file.findUnique({ where: { id: req.params.id } });
    if (!file) throw notFound('File');
    const level = await fileAccessLevel(req.user, file);
    if (!canEdit(level)) throw notFound('File');

    // Moving to another folder changes ownership location — owner/admin only.
    const isOwnerOrAdmin = level === 'owner' || level === 'admin';
    if (data.folderId !== undefined && !isOwnerOrAdmin) {
      throw badRequest('Only the owner can move this file');
    }
    if (data.folderId) {
      const f = await prisma.folder.findFirst({
        where: { id: data.folderId, ownerId: file.ownerId, trashedAt: null },
      });
      if (!f) throw notFound('Folder');
    }

    let tagOps = undefined;
    if (data.tags) {
      const upserts = await Promise.all(
        data.tags.map((name) =>
          prisma.tag.upsert({
            where: { name },
            update: {},
            create: { name },
          }),
        ),
      );
      tagOps = { set: upserts.map((t) => ({ id: t.id })) };
    }

    const updated = await prisma.file.update({
      where: { id: file.id },
      data: {
        name: data.name ?? undefined,
        folderId: data.folderId !== undefined ? data.folderId ?? null : undefined,
        tags: tagOps,
      },
      include: { tags: true },
    });
    emitFileChange(file.ownerId, file.folderId);
    if (updated.folderId !== file.folderId) emitFileChange(file.ownerId, updated.folderId);
    res.json(updated);
  }),
);

// Upload a new version (replaces current pointer; previous versions kept)
router.post(
  '/:id/versions',
  requireApproved,
  upload.single('file'),
  asyncHandler(async (req, res) => {
    if (!req.file) throw badRequest('No file uploaded');
    const file = await prisma.file.findFirst({ where: ownedWhere(req, req.params.id) });
    if (!file) throw notFound('File');
    // Charge the quota to the file's owner (an admin may be acting on someone
    // else's file).
    await assertQuota(file.ownerId, req.file.size);

    const ext = req.file.originalname.includes('.') ? req.file.originalname.split('.').pop() : '';
    const key = objectKeyFor(file.ownerId, ext);
    await putObjectStream(key, req.file.buffer, req.file.size, req.file.mimetype);

    const nextVersion = file.currentVersion + 1;
    await prisma.fileVersion.create({
      data: {
        fileId: file.id,
        version: nextVersion,
        objectKey: key,
        size: BigInt(req.file.size),
      },
    });
    const updated = await prisma.file.update({
      where: { id: file.id },
      data: {
        objectKey: key,
        size: BigInt(req.file.size),
        mimeType: req.file.mimetype,
        currentVersion: nextVersion,
        // New content invalidates the old renditions (they'd play stale video).
        hlsReady: false,
      },
      include: { versions: { orderBy: { version: 'desc' } } },
    });
    await addUsage(file.ownerId, req.file.size);
    if (file.hlsReady) removeHls(file.id).catch(() => {});
    postProcessMedia(file.id, req.file.mimetype);
    res.status(201).json(updated);
  }),
);

// Soft-delete (move file to trash)
router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const file = await prisma.file.findFirst({ where: ownedWhere(req, req.params.id) });
    if (!file) throw notFound('File');
    if (file.trashedAt) return res.json({ ok: true });
    await prisma.file.update({ where: { id: file.id }, data: { trashedAt: new Date() } });
    emitFileChange(file.ownerId, file.folderId);
    res.json({ ok: true });
  }),
);

// Bulk operations on multiple files
const bulkSchema = z.object({ ids: z.array(z.string()).min(1) });

router.post(
  '/bulk/trash',
  asyncHandler(async (req, res) => {
    const { ids } = bulkSchema.parse(req.body);
    const r = await prisma.file.updateMany({
      where: { id: { in: ids }, ...ownerScope(req), trashedAt: null },
      data: { trashedAt: new Date() },
    });
    if (r.count) emitFileChange(req.user.id);
    res.json({ count: r.count });
  }),
);

// H4 — bulk rename: client computes the new names (pattern preview) and sends
// the explicit id→name pairs; server validates ownership and applies them.
router.post(
  '/bulk/rename',
  asyncHandler(async (req, res) => {
    const { renames } = z
      .object({
        renames: z
          .array(z.object({ id: z.string(), name: z.string().trim().min(1).max(255) }))
          .min(1)
          .max(1000),
      })
      .parse(req.body);
    let count = 0;
    for (const r of renames) {
      const res2 = await prisma.file.updateMany({
        where: { id: r.id, ...ownerScope(req), trashedAt: null },
        data: { name: r.name },
      });
      count += res2.count;
    }
    if (count) emitFileChange(req.user.id);
    res.json({ count });
  }),
);

router.post(
  '/bulk/move',
  asyncHandler(async (req, res) => {
    const { ids, folderId } = z
      .object({ ids: z.array(z.string()).min(1), folderId: z.string().nullable() })
      .parse(req.body);
    if (folderId) {
      // Admin can target any folder; users only their own.
      const f = await prisma.folder.findFirst({
        where: { id: folderId, ...ownerScope(req), trashedAt: null },
      });
      if (!f) throw notFound('Folder');
    }
    const r = await prisma.file.updateMany({
      where: { id: { in: ids }, ...ownerScope(req) },
      data: { folderId },
    });
    if (r.count) emitFileChange(req.user.id, folderId);
    res.json({ count: r.count });
  }),
);

router.post(
  '/bulk/zip',
  asyncHandler(async (req, res) => {
    if (!env.zipDownloadEnabled) throw forbidden('ZIP download is temporarily disabled');
    const { ids } = bulkSchema.parse(req.body);
    const files = await prisma.file.findMany({
      where: { id: { in: ids }, ...ownerScope(req), trashedAt: null },
    });
    if (files.length === 0) throw notFound('No files');

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="files-${Date.now()}.zip"`);
    const archive = archiver('zip', { zlib: { level: 6 } });
    archive.on('warning', (e) => console.warn('[zip]', e?.message));
    archive.on('error', (e) => res.destroy(e));
    archive.pipe(res);

    for (const f of files) {
      const s = await getObjectStream(f.objectKey);
      archive.append(s, { name: f.name });
    }
    await archive.finalize();
  }),
);

// ---- Comments (any user with read access can view + add) ----
router.get(
  '/:id/comments',
  asyncHandler(async (req, res) => {
    const { file } = await readableFile(req);
    if (!file) throw notFound('File');
    const comments = await prisma.comment.findMany({
      where: { fileId: file.id },
      orderBy: { createdAt: 'asc' },
      include: { user: { select: { id: true, name: true, email: true } } },
    });
    res.json({ comments });
  }),
);

router.post(
  '/:id/comments',
  asyncHandler(async (req, res) => {
    const { body } = z.object({ body: z.string().trim().min(1).max(2000) }).parse(req.body);
    const { file } = await readableFile(req);
    if (!file) throw notFound('File');
    const comment = await prisma.comment.create({
      data: { fileId: file.id, userId: req.user.id, body },
      include: { user: { select: { id: true, name: true, email: true } } },
    });
    // Notify the file owner (if someone else commented)
    if (file.ownerId !== req.user.id) {
      notify(file.ownerId, {
        type: 'comment',
        title: `${req.user.name || req.user.email} commented on "${file.name}"`,
        body: body.slice(0, 120),
        link: '/files',
      });
    }
    // I3 — notify @mentioned users (by username/email), excluding self + owner
    // (owner already notified above) and de-duplicated.
    const mentions = [...new Set((body.match(/@([a-zA-Z0-9._-]+)/g) || []).map((m) => m.slice(1)))];
    if (mentions.length) {
      const users = await prisma.user.findMany({
        where: { email: { in: mentions } },
        select: { id: true },
      });
      const already = new Set([req.user.id, file.ownerId]);
      for (const u of users) {
        if (already.has(u.id)) continue;
        already.add(u.id);
        notify(u.id, {
          type: 'mention',
          title: `${req.user.name || req.user.email} mentioned you on "${file.name}"`,
          body: body.slice(0, 120),
          link: '/files',
        });
      }
    }
    res.status(201).json(comment);
  }),
);

// Delete a comment (author or file owner or admin)
router.delete(
  '/:id/comments/:cid',
  asyncHandler(async (req, res) => {
    const comment = await prisma.comment.findUnique({
      where: { id: req.params.cid },
      include: { file: { select: { ownerId: true } } },
    });
    if (!comment || comment.fileId !== req.params.id) throw notFound('Comment');
    const allowed =
      comment.userId === req.user.id ||
      comment.file.ownerId === req.user.id ||
      req.user.role === 'admin';
    if (!allowed) throw notFound('Comment');
    await prisma.comment.delete({ where: { id: comment.id } });
    res.json({ ok: true });
  }),
);

export default router;
