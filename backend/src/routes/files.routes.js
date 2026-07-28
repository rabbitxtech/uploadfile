// Files: single-shot upload (multer), import-from-URL/video, read + presigned
// URLs, versioning, tags, watch progress, collab-save and bulk operations.
//
// Split by concern into ./files/* — this file owns the router and the mount
// ORDER, which is load-bearing:
//   1. streamRouter   before requireAuth (authenticates via HttpOnly cookie)
//   2. requireAuth
//   3. static paths (/recent, /starred, /analytics, /duplicates, searchRouter)
//      before any `/:id` route, or Express matches them as an id
//   4. the `/:id` routes, then commentsRouter
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
import { badRequest, conflict, notFound, forbidden, HttpError } from '../utils/errors.js';
import {
  findFileNameClash,
  findFolderNameClash,
  sanitizeEntryName,
  zipEntryName,
} from '../utils/namecollision.js';
import { makeThrottle } from '../utils/throttle.js';
import {
  getObjectStream,
  objectKeyFor,
  presignedGet,
  putObjectStream,
  putObjectBuffer,
  removeObject,
} from '../services/storage.service.js';
import { assertQuota, reserveQuota, releaseQuota } from '../services/quota.service.js';
import { canThumbnail, generateThumbnail } from '../services/thumbnail.service.js';
import {
  canFaststart,
  optimizeFileVideo,
  canVideoThumbnail,
} from '../services/video.service.js';
import { fileAccessLevel, canEdit } from '../services/access.service.js';
import { postProcessMedia } from '../services/media.service.js';
import { maybeGenerateHls, removeHls } from '../services/hls.service.js';
import { maybeTranscribe } from '../services/transcribe.service.js';
import { emitFileChange } from '../realtime/bus.js';
import { sha256Buffer, backfillChecksum } from '../services/checksum.service.js';
import { indexFile } from '../services/ai.service.js';
import { downloadYoutube, isAllowedSource, SUPPORTED_SOURCES, mimeForExt } from '../services/youtube.service.js';
import { streamRouter } from './files/stream.routes.js';
import { searchRouter } from './files/search.routes.js';
import { commentsRouter } from './files/comments.routes.js';
import {
  makeVideoThumb,
  bumpAccessed,
  readableFile,
  ownedWhere,
  ownerScope,
  mimeCategory,
  stripIndexFieldsAll,
  STREAM_EXPIRY,
  STREAM_MAX_AGE_MS,
  STREAM_COOKIE,
  INLINE_EXPIRY,
  DOWNLOAD_EXPIRY,
} from './files/_shared.js';

const router = Router();

/**
 * Refuse an incoming file whose name is already a live FOLDER in the same place.
 *
 * Note this deliberately does NOT refuse a file that duplicates another FILE's
 * name: uploading two files called "report.pdf" into one folder is long-standing
 * product behaviour (the Uploader detects it client-side and offers a replace,
 * and keeping both is a legitimate choice), and both rows stay visible in the
 * REST listing, so nothing is hidden.
 *
 * A file taking a FOLDER's name is a different thing entirely. WebDAV resolves a
 * path segment by trying the folder first, so the folder shadows the file for
 * PROPFIND, GET and DELETE — the upload is live and billed against the quota but
 * cannot be read or removed there, which is the same unreachable-row state the
 * trashed-parent gates and the restore-ancestor walk exist to prevent.
 */
async function assertFileNameFree(ownerId, folderId, name) {
  if (await findFolderNameClash(ownerId, folderId ?? null, name)) {
    throw conflict('A folder with that name already exists here');
  }
}

// Stream + HLS live in ./files/stream.routes.js and MUST stay mounted before
// requireAuth: they authenticate with the stream_tkn HttpOnly cookie because a
// browser cannot set an Authorization header on <video src>.
router.use(streamRouter);

router.use(requireAuth);

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
    // A multipart filename is attacker-controlled: nothing stops a client sending
    // `filename="a/b/c.txt"`, and the name is stored verbatim and later read back
    // as structure (WebDAV path resolution, ZIP entry names). Stripped rather
    // than refused because the bytes are already here and clients put a path in
    // that header routinely — see sanitizeEntryName.
    const fileName = sanitizeEntryName(req.file.originalname, {
      label: 'filename',
      mode: 'strip',
    });
    await assertFileNameFree(req.user.id, folderId, fileName);
    // Reserve the bytes atomically instead of check-then-charge: the old
    // assertQuota/addUsage pair let concurrent uploads all read the same balance
    // and all commit, so N parallel uploads overshot the quota N-fold (the
    // browser uploads several files at once, so no attacker was needed).
    await reserveQuota(req.user.id, req.file.size);

    const ext = fileName.includes('.') ? fileName.split('.').pop() : '';
    const key = objectKeyFor(req.user.id, ext);
    let file;
    try {
      await putObjectStream(key, req.file.buffer, req.file.size, req.file.mimetype);
      const checksum = sha256Buffer(req.file.buffer);

      file = await prisma.file.create({
        data: {
          name: fileName,
          originalName: fileName,
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
    } catch (e) {
      // The reservation is already charged, so anything that stops the row being
      // created has to give it back or the user is billed for bytes they don't
      // have. Best-effort on the object too — nothing will ever reference it.
      await releaseQuota(req.user.id, req.file.size);
      removeObject(key).catch(() => {});
      throw e;
    }

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
    res.json({ files: stripIndexFieldsAll(files) });
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
    res.json({ files: stripIndexFieldsAll(files) });
  }),
);

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
  // Popping the last "/" segment is not enough on its own. A percent-encoded
  // BACKSLASH survives decodeURIComponent and this split, so
  // "/%2e%2e%5C%2e%2e%5Cx.txt" yielded the literal name "..\..\x.txt" — and a
  // backslash is a separator to WebDAV clients on Windows and to the ZIP spec
  // alike, which is exactly the forged-path shape sanitizeEntryName exists to
  // stop. 'strip' rather than 'reject': the remote picked this string, not the
  // user, and the useful answer is its last segment (which is what this helper
  // has always tried to return). Falls back to a plain name when nothing usable
  // is left, so a hostile URL can't fail an otherwise valid import.
  try {
    name = sanitizeEntryName(name, { mode: 'strip' });
  } catch {
    name = 'download';
  }
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

    const contentType = (resp.headers.get('content-type') || 'application/octet-stream')
      .split(';')[0]
      .trim();
    const name = filenameFromUrl(url, contentType);
    await assertFileNameFree(req.user.id, folderId || null, name);
    const ext = name.includes('.') ? name.split('.').pop() : '';
    const key = objectKeyFor(req.user.id, ext);
    // Reserve against the ACTUAL byte count, atomically — the declared
    // content-length check above is only an early exit, and check-then-charge
    // let concurrent fetches overshoot the quota. See reserveQuota.
    await reserveQuota(req.user.id, total);
    let file;
    try {
      await putObjectStream(key, buffer, total, contentType);
      const checksum = sha256Buffer(buffer);

      file = await prisma.file.create({
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
    } catch (e) {
      await releaseQuota(req.user.id, total);
      removeObject(key).catch(() => {});
      throw e;
    }

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
    let reserved = 0; // bytes reserved against the quota, released if we never commit
    try {
      const total = dl.size;
      // One segment, like every other path that takes a name from outside. This
      // one is the least likely to carry a separator — the name is a single
      // readdir entry and yt-dlp runs with --restrict-filenames — but it is the
      // last place a foreign string still became a File.name unchecked, and
      // 'strip' costs nothing. Falls back rather than failing: the video is
      // already downloaded, and the response is mid-stream.
      let videoName;
      try {
        videoName = sanitizeEntryName(dl.name, { label: 'filename', mode: 'strip' });
      } catch {
        videoName = `video.${dl.ext || 'mp4'}`;
      }
      // The name only exists once yt-dlp has finished, so this check lands here
      // rather than up front; headers are already sent, so it is reported as an
      // error EVENT rather than thrown. Same rule as every other upload path: a
      // file must not take a live folder's name, or WebDAV shadows it.
      try {
        await assertFileNameFree(req.user.id, folderId || null, videoName);
      } catch (e) {
        send({ type: 'error', error: e?.message || 'A folder with that name already exists here' });
        return res.end();
      }
      try {
        // Reserved atomically (see reserveQuota) rather than checked and charged
        // separately. `reserved` drives the release in the catch below: the bytes
        // are owed only once the File row exists.
        await reserveQuota(req.user.id, total); // 413 if the video exceeds quota
        reserved = total;
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
          name: videoName,
          originalName: videoName,
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

      backfillChecksum(file.id, key); // dedup checksum (async, streams from MinIO)
      if (canVideoThumbnail(mimeType)) makeVideoThumb(file.id, key, mimeType);
      postProcessMedia(file.id, mimeType); // faststart → HLS + transcribe
      indexFile(file.id); // K1/K4
      emitFileChange(req.user.id, folderId || null);

      send({ type: 'done', file });
    } catch (e) {
      if (uploadedKey && !committed) removeObject(uploadedKey).catch(() => {}); // drop the orphan
      // Give back a reservation the File row never claimed. This route reports
      // failures as NDJSON events rather than throwing, so without this the
      // bytes of every failed import stayed charged forever.
      if (reserved && !committed) await releaseQuota(req.user.id, reserved).catch(() => {});
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
    // Same rule as the version upload: a trashed file is pending deletion, and
    // this kicks off a remux plus HLS/whisper backfill whose renditions the
    // hard-delete paths only clean up via removeHls(). Don't start that work on
    // a file that is on its way out.
    const file = await prisma.file.findFirst({
      where: { ...ownedWhere(req, req.params.id), trashedAt: null },
    });
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
// Search, semantic search and reindex live in ./files/search.routes.js.
// Mounted here (before the /:id routes) so Express does not match "search"
// as an id.
router.use(searchRouter);

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

    // A trashed file is not a rename/move target. This is the single-file
    // equivalent of the rule /bulk/move carries, and the route the UI actually
    // drives for a rename or a drag-and-drop move. Moving one relocates an item
    // the listing hides — nothing appears to happen, and the file resurfaces on
    // restore in a folder the user never chose; renaming one changes the entry
    // out from under them in the trash view, which lists the name.
    //
    // The gate belongs on the file rather than on `canEdit`: fileAccessLevel
    // returns 'admin' for any file, so for an admin this filter is the only
    // check in the way. The star toggle and the soft-delete deliberately keep
    // working on a trashed row and so do NOT get this filter.
    const file = await prisma.file.findFirst({
      where: { id: req.params.id, trashedAt: null },
    });
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

    // One name, one resource per (owner, folder). WebDAV resolves a path segment
    // with findFirst, so two live files under one name make row order decide
    // which one a client reads, overwrites or deletes — and the other stays
    // billed while being unreachable over WebDAV entirely. A file that takes a
    // sibling FOLDER's name is worse: PROPFIND tries the folder first and
    // answers <D:collection/>, and DELETE takes the folder branch, so the file
    // becomes both unreadable and undeletable there. The WebDAV MOVE already
    // refuses both (RFC 4918 replace-or-412); this is the REST way in, and it is
    // the one the rename UI actually drives.
    const targetFolderId = data.folderId !== undefined ? data.folderId ?? null : file.folderId;
    // One segment only. A rename was the easiest way in: the stored name is read
    // back as structure by WebDAV's path resolution and by the ZIP entry writer,
    // so "sub/evil.txt" made the row unresolvable over WebDAV and
    // "../../../tmp/x" shipped a Zip Slip entry. See sanitizeEntryName.
    const targetName =
      data.name !== undefined ? sanitizeEntryName(data.name, { label: 'filename' }) : file.name;
    if (targetName !== file.name || targetFolderId !== file.folderId) {
      const fileClash = await findFileNameClash(file.ownerId, targetFolderId, targetName, file.id);
      if (fileClash) throw conflict('A file with that name already exists here');
      const folderClash = await findFolderNameClash(file.ownerId, targetFolderId, targetName);
      if (folderClash) throw conflict('A folder with that name already exists here');
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
        name: data.name !== undefined ? targetName : undefined,
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
    // `trashedAt: null` is not optional here. A trashed file is on its way out:
    // the retention sweep and both hard-delete paths refund the SUM of its
    // FileVersion rows and remove every version's object. Minting a version on
    // a trashed file charges the owner for bytes attached to a row the user
    // can't see (the trash view lists File.size, not the history) and that they
    // never asked to keep — and if the sweep runs between this quota charge and
    // a restore, the file is gone while the bytes were only just added. Every
    // other content-write path already refuses a trashed target: collab-save
    // checks `file.trashedAt`, upload/init scopes `replaceFileId` to
    // `trashedAt: null`, and the WebDAV PUT overwrite looks the file up with it.
    const file = await prisma.file.findFirst({
      where: { ...ownedWhere(req, req.params.id), trashedAt: null },
    });
    if (!file) throw notFound('File');
    // Charge the quota to the file's owner (an admin may be acting on someone
    // else's file). Reserved atomically — a version upload adds bytes on top of
    // the existing ones, so concurrent version uploads raced the same way plain
    // uploads did. See reserveQuota.
    await reserveQuota(file.ownerId, req.file.size);

    // Only the extension is taken from the upload here (a new version keeps the
    // file's existing name), but the raw multipart filename can still carry a
    // "/" — which would land inside the MinIO object key and fabricate a prefix.
    // Reduce it to one segment first, as every other path does.
    const versionName = sanitizeEntryName(req.file.originalname, {
      label: 'filename',
      mode: 'strip',
    });
    const ext = versionName.includes('.') ? versionName.split('.').pop() : '';
    const key = objectKeyFor(file.ownerId, ext);
    let updated;
    try {
      await putObjectStream(key, req.file.buffer, req.file.size, req.file.mimetype);
      // Every other write path stores the checksum on BOTH the File and its
      // version row, and the rest of the codebase reads File.checksum as "the hash
      // of the CURRENT bytes". Leaving it at the previous version's value here made
      // this the one path that desynced it: /duplicates then groups the file with
      // whatever still matches its superseded content, and collab-save's
      // `checksum === file.checksum` short-circuit reads a fresh upload as
      // "unchanged" and silently drops the next edit.
      const checksum = sha256Buffer(req.file.buffer);

      const nextVersion = file.currentVersion + 1;
      await prisma.fileVersion.create({
        data: {
          fileId: file.id,
          version: nextVersion,
          objectKey: key,
          size: BigInt(req.file.size),
          checksum,
        },
      });
      updated = await prisma.file.update({
        where: { id: file.id },
        data: {
          objectKey: key,
          size: BigInt(req.file.size),
          mimeType: req.file.mimetype,
          currentVersion: nextVersion,
          checksum,
          // New content invalidates the old renditions (they'd play stale video).
          hlsReady: false,
          // ...and the thumbnail, for exactly the same reason. It is derived
          // from the SUPERSEDED object (thumbnail.service.js builds the key
          // from the source key, and objectKeyFor mints a fresh UUID per
          // write), while `GET /files/:id/thumbnail` gates on nothing but this
          // key being set — so leaving it renders the previous version's
          // picture as the current file's preview. A fresh one is generated
          // below when the NEW content supports it; until then the file simply
          // has no thumbnail, which is honest rather than wrong.
          thumbnailKey: null,
          hasPreview: false,
        },
        include: { versions: { orderBy: { version: 'desc' } } },
      });
    } catch (e) {
      await releaseQuota(file.ownerId, req.file.size);
      removeObject(key).catch(() => {});
      throw e;
    }
    if (file.hlsReady) removeHls(file.id).catch(() => {});
    // Nothing else references the old thumbnail once the key is cleared, and no
    // delete path can find it afterwards — the row no longer names it.
    if (file.thumbnailKey) removeObject(file.thumbnailKey).catch(() => {});
    // Regenerate for the new content. This path previously generated no
    // thumbnail at all, so a new version of an image kept the FIRST version's
    // preview indefinitely; every other upload path does this.
    if (canThumbnail(req.file.mimetype)) {
      generateThumbnail(key, req.file.mimetype)
        .then((thumbKey) => {
          if (thumbKey)
            return prisma.file.update({
              where: { id: file.id },
              data: { thumbnailKey: thumbKey, hasPreview: true },
            });
        })
        .catch((e) => console.warn('[thumb] failed:', e?.message));
    } else if (canVideoThumbnail(req.file.mimetype)) {
      makeVideoThumb(file.id, key, req.file.mimetype);
    }
    postProcessMedia(file.id, req.file.mimetype);
    res.status(201).json(updated);
  }),
);

// Task5 #6 — collaborative editor save. Persists the current editor text as a
// new FileVersion. Any approved user with EDIT access may save (grantees
// included) — requireApproved keeps this consistent with the upload/version
// gate, since a save mints a FileVersion. Quota is charged to the file's owner.
// Identical content is a no-op (no version), which dedupes concurrent autosaves
// and protects against version spam.
const COLLAB_MAX_BYTES = 1024 * 1024;
// Must stay a superset of the frontend's isTextual() in PreviewModal.jsx — the
// "Edit" button is only shown for files this accepts, so any drift here means
// the FE offers editing on a file the save endpoint then 400-rejects.
const COLLAB_TEXT_MIMES = new Set([
  'application/json', 'application/javascript', 'application/xml', 'application/x-yaml',
]);
const COLLAB_TEXT_EXTS = new Set([
  'md', 'markdown', 'txt', 'log', 'csv', 'json', 'xml', 'yml', 'yaml', 'toml', 'ini',
  'html', 'htm', 'css', 'scss', 'less', 'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx',
  'py', 'rb', 'go', 'rs', 'java', 'kt', 'c', 'h', 'cpp', 'cc', 'hpp', 'cs', 'php',
  'sh', 'bash', 'zsh', 'sql', 'swift', 'dart', 'vue', 'dockerfile', 'makefile',
  'env', 'gitignore', 'conf',
]);
function isCollabEditable(file) {
  const mime = file.mimeType || '';
  if (mime.startsWith('text/') || COLLAB_TEXT_MIMES.has(mime)) return true;
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  return COLLAB_TEXT_EXTS.has(ext);
}

router.post(
  '/:id/collab-save',
  requireApproved,
  asyncHandler(async (req, res) => {
    const { text } = z.object({ text: z.string().max(COLLAB_MAX_BYTES * 2) }).parse(req.body);
    const file = await prisma.file.findUnique({ where: { id: req.params.id } });
    if (!file || file.trashedAt) throw notFound('File');
    const level = await fileAccessLevel(req.user, file);
    if (!canEdit(level)) throw forbidden();
    if (!isCollabEditable(file)) throw badRequest('Not an editable text file');

    const buf = Buffer.from(text, 'utf8');
    if (buf.length > COLLAB_MAX_BYTES) throw badRequest('File too large to save (max 1 MB)');
    const checksum = sha256Buffer(buf);
    // Unchanged → don't mint a version (dedupes multi-client autosaves).
    if (checksum === file.checksum) {
      return res.json({ ok: true, unchanged: true, version: file.currentVersion });
    }

    // Reserved atomically (see reserveQuota). Every exit below that does NOT
    // mint a version must release it again — the bytes are only owed once the
    // FileVersion row exists.
    await reserveQuota(file.ownerId, buf.length);
    const ext = file.name.includes('.') ? file.name.split('.').pop() : 'txt';
    const key = objectKeyFor(file.ownerId, ext);
    try {
      await putObjectBuffer(key, buf, file.mimeType || 'text/plain');
    } catch (e) {
      await releaseQuota(file.ownerId, buf.length);
      throw e;
    }

    // Two clients can flush different content for the same file at the same
    // instant (the close-flush isn't leader-gated). Both would read the same
    // currentVersion and try to mint the same version number, tripping the
    // @@unique([fileId, version]) constraint (P2002). Re-read the version inside
    // a small bounded retry so the loser re-targets the next free number instead
    // of 500-ing and dropping its edit. The version row + file pointer move
    // together in one transaction so a partial bump can't leave the file
    // pointing at a version that doesn't exist.
    const size = BigInt(buf.length);
    let nextVersion = null;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const fresh = await prisma.file.findUnique({
        where: { id: file.id },
        select: { currentVersion: true, checksum: true, trashedAt: true },
      });
      if (!fresh || fresh.trashedAt) {
        await releaseQuota(file.ownerId, buf.length);
        removeObject(key).catch(() => {});
        throw notFound('File');
      }
      // Another writer already saved this exact content → don't mint a dup; the
      // object we just uploaded is now an orphan, so drop it (best-effort).
      if (fresh.checksum === checksum) {
        await releaseQuota(file.ownerId, buf.length);
        removeObject(key).catch(() => {});
        return res.json({ ok: true, unchanged: true, version: fresh.currentVersion });
      }
      const candidate = fresh.currentVersion + 1;
      try {
        await prisma.$transaction([
          prisma.fileVersion.create({
            data: { fileId: file.id, version: candidate, objectKey: key, size, checksum },
          }),
          prisma.file.update({
            where: { id: file.id },
            data: { objectKey: key, size, checksum, currentVersion: candidate },
          }),
        ]);
        nextVersion = candidate;
        break;
      } catch (e) {
        if (e?.code === 'P2002') continue; // version race — re-read and retry
        await releaseQuota(file.ownerId, buf.length);
        removeObject(key).catch(() => {}); // unexpected failure: don't strand the object
        throw e;
      }
    }
    if (nextVersion === null) {
      await releaseQuota(file.ownerId, buf.length);
      removeObject(key).catch(() => {});
      throw new HttpError(409, 'Could not save — too many concurrent edits, try again');
    }
    emitFileChange(file.ownerId, file.folderId);
    res.json({ ok: true, version: nextVersion });
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
    // The same one-name-one-resource rule PATCH /:id enforces. This route is the
    // likeliest way to break it: the client generates the names from a pattern,
    // and a pattern that collapses two files onto one name ("photo (1).jpg" and
    // "photo (2).jpg" → "photo.jpg") produces exactly the duplicate that makes
    // WebDAV's findFirst resolution pick a row by chance, leaving the other live,
    // billed and unreachable. Colliding entries are SKIPPED rather than failing
    // the batch — the route already reports a `count` that can be lower than what
    // was asked for (unowned/trashed ids drop out the same way), and a bulk
    // rename of 200 files should not be lost to one clash.
    let count = 0;
    let skipped = 0;
    for (const r of renames) {
      const file = await prisma.file.findFirst({
        where: { id: r.id, ...ownerScope(req), trashedAt: null },
        select: { id: true, ownerId: true, folderId: true, name: true },
      });
      if (!file) continue;
      // The names come from a client-side pattern, so a "/" in one is a mistake
      // in the pattern rather than a deliberate act — skip that entry the same
      // way a collision is skipped, instead of failing the whole batch.
      let newName;
      try {
        newName = sanitizeEntryName(r.name, { label: 'filename' });
      } catch {
        skipped += 1;
        continue;
      }
      if (newName !== file.name) {
        const clash =
          (await findFileNameClash(file.ownerId, file.folderId, newName, file.id)) ||
          (await findFolderNameClash(file.ownerId, file.folderId, newName));
        if (clash) {
          skipped += 1;
          continue;
        }
      }
      const res2 = await prisma.file.updateMany({
        where: { id: file.id, trashedAt: null },
        data: { name: newName },
      });
      count += res2.count;
    }
    if (count) emitFileChange(req.user.id);
    res.json({ count, skipped });
  }),
);

router.post(
  '/bulk/move',
  asyncHandler(async (req, res) => {
    const { ids, folderId } = z
      .object({ ids: z.array(z.string()).min(1), folderId: z.string().nullable() })
      .parse(req.body);
    // Resolve the files first: the destination has to be validated against each
    // FILE's owner, not against the caller. `ownerScope` is `{}` for an admin, so
    // checking the folder that way let an admin move one user's files into a
    // THIRD user's folder — the row keeps its original ownerId, but it now sits
    // in someone else's tree, where that owner and their folder grantees can
    // read it. The single-file PATCH already scopes the target folder to
    // `ownerId: file.ownerId`; this is the same rule applied in bulk.
    //
    // Trashed files are excluded, as every other bulk operation does (bulk/trash,
    // bulk/rename and bulk/zip all filter `trashedAt: null`). Moving one
    // relocated an item the listing hides, so it silently reappeared in a folder
    // the user never put it in when they later restored it.
    const files = await prisma.file.findMany({
      where: { id: { in: ids }, ...ownerScope(req), trashedAt: null },
      select: { id: true, ownerId: true, folderId: true, name: true },
    });
    if (files.length === 0) return res.json({ count: 0, skipped: 0 });

    if (folderId) {
      const owners = [...new Set(files.map((f) => f.ownerId))];
      const dest = await prisma.folder.findFirst({
        where: { id: folderId, trashedAt: null },
        select: { ownerId: true },
      });
      if (!dest) throw notFound('Folder');
      // A single move cannot span owners, and never crosses into a tree the
      // files' owner does not own.
      if (owners.length > 1 || owners[0] !== dest.ownerId) throw notFound('Folder');
    }

    // Moving into a folder can collide the same way a rename does — with a file
    // already sitting there under that name, or with a subfolder of that name.
    // A move that lands a second live row under one name leaves whichever row
    // WebDAV's findFirst does not pick unreachable and still billed, so drop the
    // colliding items and report them, exactly as bulk/rename does. Names moving
    // together in one batch are tracked in `taken` as they are committed, so two
    // same-named files from different folders can't both land in the destination.
    const moving = [];
    const taken = new Set();
    let skipped = 0;
    for (const f of files) {
      if (f.folderId === (folderId ?? null)) continue; // already there: no-op, no clash
      const key = `${f.ownerId}::${f.name}`;
      const clash =
        taken.has(key) ||
        (await findFileNameClash(f.ownerId, folderId ?? null, f.name, f.id)) ||
        (await findFolderNameClash(f.ownerId, folderId ?? null, f.name));
      if (clash) {
        skipped += 1;
        continue;
      }
      taken.add(key);
      moving.push(f);
    }
    if (moving.length === 0) return res.json({ count: 0, skipped });

    const r = await prisma.file.updateMany({
      where: { id: { in: moving.map((f) => f.id) } },
      data: { folderId },
    });
    // Refresh both the source folders and the destination for every viewer.
    for (const owner of new Set(moving.map((f) => f.ownerId))) {
      for (const src of new Set(moving.filter((f) => f.ownerId === owner).map((f) => f.folderId))) {
        emitFileChange(owner, src);
      }
      emitFileChange(owner, folderId);
    }
    res.json({ count: r.count, skipped });
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

    // The entry name goes into the ZIP central directory verbatim, so a stored
    // name containing "/" or ".." is a Zip Slip entry for whoever extracts it.
    // The write paths now reject those, but rows created before that still
    // carry them, so the reader sanitises too — a name is one segment here as
    // well. `zipEntryName` never throws: a download must not 500 over one bad
    // legacy row.
    for (const f of files) {
      const s = await getObjectStream(f.objectKey);
      archive.append(s, { name: zipEntryName(f.name) });
    }
    await archive.finalize();
  }),
);

// Comments live in ./files/comments.routes.js.
router.use(commentsRouter);

export default router;
