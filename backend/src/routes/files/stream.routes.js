// Authenticated media streaming — mounted BEFORE requireAuth on purpose.
//
// Browsers cannot set an Authorization header on <video src> or on hls.js
// segment requests, so these two routes authenticate with a short-lived,
// file+user-bound JWT delivered as an HttpOnly+Secure+SameSite cookie (never in
// the URL, where it would be a shareable, replayable 3h bearer credential that
// leaks through history, logs and Referer). The object never leaves the backend
// — no presigned MinIO URL is ever exposed for video — and access is re-checked
// on every request, so revoking a grant takes effect immediately.
//
// If these move below the requireAuth mount, cookie playback 401s.
import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { prisma } from '../../config/prisma.js';
import { env } from '../../config/env.js';
import { asyncHandler } from '../../utils/async.js';
import { notFound, unauthorized, forbidden } from '../../utils/errors.js';
import { getObjectStream, getObjectRange } from '../../services/storage.service.js';
import { fileAccessLevel } from '../../services/access.service.js';
import { hlsPrefix } from '../../services/hls.service.js';
import { parseRange } from '../../utils/range.js';
import { readCookie, bumpAccessed, STREAM_COOKIE } from './_shared.js';

export const streamRouter = Router();

/**
 * Validate the stream cookie for /:id/stream and /:id/stream/hls/*.
 * Rejects a token minted for a different file, and re-checks access so a
 * revoked grant cannot keep streaming on an already-issued token.
 */
async function streamAuth(req) {
  const token = readCookie(req, STREAM_COOKIE);
  if (!token) throw unauthorized('Missing stream credential');
  let payload;
  try {
    payload = jwt.verify(token, env.jwtSecret);
  } catch {
    throw unauthorized('Invalid or expired stream token');
  }
  if (payload.p !== 'stream' || payload.fid !== req.params.id) {
    throw unauthorized('Invalid stream token');
  }

  const user = await prisma.user.findUnique({ where: { id: payload.sub } });
  if (!user || user.banned) throw forbidden('No access');
  const file = await prisma.file.findFirst({ where: { id: req.params.id, trashedAt: null } });
  if (!file) throw notFound('File');
  const level = await fileAccessLevel(user, file);
  if (!level) throw notFound('File'); // access revoked since the token was issued
  return file;
}

streamRouter.get(
  '/:id/stream',
  asyncHandler(async (req, res) => {
    const file = await streamAuth(req);

    const size = Number(file.size);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Type', file.mimeType);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(file.name)}"`);

    const range = parseRange(req.headers.range, size);
    if (range?.unsatisfiable) {
      res.status(416).setHeader('Content-Range', `bytes */${size}`);
      return res.end();
    }
    if (range) {
      const { start, end, length } = range;
      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
      res.setHeader('Content-Length', length);
      const stream = await getObjectRange(file.objectKey, start, length);
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
// subpath per RFC 6265, so hls.js requests carry it automatically. Flat layout
// — playlists reference segments by bare filename, all served from here.
streamRouter.get(
  '/:id/stream/hls/:name',
  asyncHandler(async (req, res) => {
    const file = await streamAuth(req);
    const { name } = req.params;
    // The name is interpolated into an object key, so keep this strict — it is
    // what stops ../ traversal out of the file's HLS prefix.
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
