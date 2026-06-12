// Thin wrapper around MinIO with multipart upload helpers used for chunked/resumable uploads.
import crypto from 'node:crypto';
import { minio, minioPublic, BUCKET } from '../config/minio.js';

export function objectKeyFor(userId, ext = '') {
  const id = crypto.randomUUID();
  const safeExt = ext ? (ext.startsWith('.') ? ext : '.' + ext) : '';
  return `u/${userId}/${id}${safeExt}`;
}

export async function putObjectStream(key, stream, size, contentType) {
  return minio.putObject(BUCKET, key, stream, size, { 'Content-Type': contentType });
}

export async function putObjectBuffer(key, buf, contentType) {
  return minio.putObject(BUCKET, key, buf, buf.length, { 'Content-Type': contentType });
}

export async function getObjectStream(key) {
  return minio.getObject(BUCKET, key);
}

// Partial read for HTTP Range requests (video seeking). length omitted = to EOF.
export async function getObjectRange(key, offset, length) {
  return minio.getPartialObject(BUCKET, key, offset, length);
}

export async function removeObject(key) {
  try {
    await minio.removeObject(BUCKET, key);
  } catch (e) {
    // ignore missing objects
    if (e?.code !== 'NoSuchKey') console.warn('[storage] removeObject:', e?.message);
  }
}

export async function statObject(key) {
  return minio.statObject(BUCKET, key);
}

// Remove every object under a key prefix (e.g. HLS renditions h/<fileId>/).
export async function removePrefix(prefix) {
  const keys = await new Promise((resolve, reject) => {
    const out = [];
    const stream = minio.listObjectsV2(BUCKET, prefix, true);
    stream.on('data', (o) => o?.name && out.push(o.name));
    stream.on('end', () => resolve(out));
    stream.on('error', reject);
  });
  if (keys.length) await minio.removeObjects(BUCKET, keys);
}

export async function presignedGet(key, expirySeconds = 600, filename) {
  const headers = {};
  if (filename) {
    headers['response-content-disposition'] =
      `attachment; filename="${encodeURIComponent(filename)}"`;
  } else {
    // Inline preview (no filename): tell the browser it may cache the bytes so
    // media seeking can reuse already-downloaded ranges instead of re-buffering.
    headers['response-cache-control'] = 'private, max-age=3600';
  }
  // Sign with the public-facing client so the URL host is browser-reachable
  // (e.g. http://localhost:9000 instead of the Docker hostname `minio`).
  return minioPublic.presignedGetObject(BUCKET, key, expirySeconds, headers);
}

// ---- multipart (chunked / resumable) ----
//
// The MinIO Node SDK doesn't expose a clean multipart API; we use the internal
// helpers it ships under `Client.prototype`. Names are stable across 7.x/8.x.

export async function initiateMultipart(key, contentType) {
  return minio.initiateNewMultipartUpload(BUCKET, key, { 'Content-Type': contentType });
}

export async function uploadPart({ key, uploadId, partNumber, body, length }) {
  // minio-js 8.x signature: uploadPart(partConfig, payload).
  // The body MUST be passed as the second arg — putting it inside partConfig
  // sends an empty payload (ETag = MD5 of empty string).
  const result = await minio.uploadPart(
    {
      bucketName: BUCKET,
      objectName: key,
      uploadID: uploadId,
      partNumber,
      headers: { 'Content-Length': length },
    },
    body,
  );
  return { partNumber, etag: result.etag, size: length };
}

export async function completeMultipart(key, uploadId, parts) {
  const sorted = [...parts].sort((a, b) => a.partNumber - b.partNumber);
  const etags = sorted.map((p) => ({ part: p.partNumber, etag: p.etag }));
  return minio.completeMultipartUpload(BUCKET, key, uploadId, etags);
}

export async function abortMultipart(key, uploadId) {
  try {
    await minio.abortMultipartUpload(BUCKET, key, uploadId);
  } catch (e) {
    console.warn('[storage] abortMultipart:', e?.message);
  }
}
