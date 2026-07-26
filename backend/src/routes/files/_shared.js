// Helpers shared by the files/* route modules.
//
// files.routes.js was one 1370-line file covering upload, streaming, search,
// versions, comments and bulk operations. It is now split by concern, with the
// pieces every module needs living here so the split does not turn into copies
// that drift apart.
//
// IMPORTANT — access-control semantics (verified by
// test/integration/files-access.test.js):
//   readableFile()  read access: owner, admin, or a file/folder grant.
//   ownedWhere()    WRITE access, and it deliberately drops the ownerId filter
//                   for admins — an admin can rename/move/trash ANY user's
//                   file. The read-only "view as user" behaviour is a frontend
//                   convention (pages/Files.jsx hides the controls), NOT an API
//                   guarantee. Don't "tighten" this without changing the tests
//                   on purpose.
import { prisma } from '../../config/prisma.js';
import { fileAccessLevel } from '../../services/access.service.js';
import { generateVideoThumbnail } from '../../services/video.service.js';

// PostgreSQL is the only provider where Prisma supports case-insensitive
// `mode`; MySQL/SQLite rely on their collation instead. Never hardcode
// `mode: 'insensitive'` — it throws on the other two.
export const PG = (process.env.DB_PROVIDER || 'postgresql') === 'postgresql';
export const ciContains = (q) => (PG ? { contains: q, mode: 'insensitive' } : { contains: q });

export const STREAM_EXPIRY = '3h';
export const STREAM_MAX_AGE_MS = 3 * 60 * 60 * 1000; // keep in sync with STREAM_EXPIRY
export const STREAM_COOKIE = 'stream_tkn';

export const INLINE_EXPIRY = 6 * 60 * 60; // 6 hours
export const DOWNLOAD_EXPIRY = 10 * 60; // 10 minutes

/** Read a single cookie from the raw header (avoids a cookie-parser dep). */
export function readCookie(req, name) {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

/** Generate a video poster thumbnail (best-effort, async). */
export function makeVideoThumb(fileId, objectKey, mimeType) {
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

/**
 * Strip the two index-only columns from a File row before it goes over the wire.
 *
 * `embedding` is a 384-float JSON string and `ocrText` is the file's ENTIRE
 * extracted text — a whole PDF's contents, or a video's transcript. Both exist
 * to be searched against server-side; no client code reads either. Returned on a
 * 200-row folder page or a 100-row search hit they dominate the response,
 * turning an ordinary listing into megabytes of payload carrying nothing the UI
 * renders. /semantic-search always dropped them; every list endpoint owes the
 * same treatment, so do it in one place rather than repeating the destructure.
 *
 * Single-file reads deliberately do NOT use this — /files/:id is one row, and
 * ocrText there is the file's own indexed text.
 */
export function stripIndexFields(file) {
  if (!file) return file;
  const { embedding, ocrText, ...rest } = file;
  return rest;
}

/** Map stripIndexFields over a list of File rows. */
export const stripIndexFieldsAll = (files) => files.map(stripIndexFields);

/** Bump File.accessedAt asynchronously (best-effort, no await). */
export function bumpAccessed(id) {
  prisma.file.updateMany({ where: { id }, data: { accessedAt: new Date() } }).catch(() => {});
}

/**
 * Fetch a file the user may READ (owner, admin, or granted via a file/folder
 * share). Returns { file, level }; file is null when there is no access, so
 * callers 404 rather than disclosing existence.
 */
export async function readableFile(req, include) {
  const file = await prisma.file.findUnique({ where: { id: req.params.id }, include });
  if (!file) return { file: null, level: null };
  const level = await fileAccessLevel(req.user, file);
  if (!level) return { file: null, level: null };
  return { file, level };
}

/**
 * Prisma where-filter for WRITE operations: admins act on ANY file/folder,
 * regular users are scoped to what they own. See the note at the top of this
 * file before changing.
 */
export function ownedWhere(req, id) {
  if (req.user.role === 'admin') return { id };
  return { id, ownerId: req.user.id };
}

export function ownerScope(req) {
  return req.user.role === 'admin' ? {} : { ownerId: req.user.id };
}

export function mimeCategory(mime = '') {
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
