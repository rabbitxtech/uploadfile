import { Client } from 'minio';
import { env } from './env.js';

export const minio = new Client({
  endPoint: env.minio.endPoint,
  port: env.minio.port,
  useSSL: env.minio.useSSL,
  accessKey: env.minio.accessKey,
  secretKey: env.minio.secretKey,
});

// Separate client used only to sign URLs that the browser will hit. Inside
// Docker the API endpoint is `minio` (internal hostname) — that hostname can't
// be resolved from the user's browser, so presigned URLs must be signed
// against the public endpoint (e.g. http://localhost:9000) instead.
function parsePublicEndpoint(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    return {
      endPoint: u.hostname,
      port: u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80,
      useSSL: u.protocol === 'https:',
    };
  } catch {
    return null;
  }
}

const publicCfg = parsePublicEndpoint(env.minio.publicEndpoint);
export const minioPublic = publicCfg
  ? new Client({
      ...publicCfg,
      accessKey: env.minio.accessKey,
      secretKey: env.minio.secretKey,
      // Skip the GetBucketLocation lookup — that would try to reach the
      // public host from inside the container and fail with ECONNREFUSED.
      region: 'us-east-1',
    })
  : minio;

export const BUCKET = env.minio.bucket;

export async function ensureBucket() {
  const exists = await minio.bucketExists(BUCKET).catch(() => false);
  if (!exists) {
    await minio.makeBucket(BUCKET);
    console.log(`Created MinIO bucket: ${BUCKET}`);
  }
}
