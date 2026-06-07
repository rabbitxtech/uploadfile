import 'dotenv/config';

function int(name, def) {
  const v = process.env[name];
  return v ? parseInt(v, 10) : def;
}

function bool(name, def) {
  const v = process.env[name];
  if (v === undefined) return def;
  return v === 'true' || v === '1';
}

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env: ${name}`);
  return v;
}

export const env = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: int('PORT', 4000),
  jwtSecret: process.env.JWT_SECRET || 'dev-secret-change-me',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',
  corsOrigin: (process.env.CORS_ORIGIN || 'http://localhost:5173')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  publicBaseUrl: process.env.PUBLIC_BASE_URL || 'http://localhost:4000',
  defaultQuotaBytes: BigInt(process.env.DEFAULT_QUOTA_BYTES || '5368709120'),
  // Files/folders left in trash longer than this are hard-deleted by a
  // background job (0 disables auto-clean). See services/retention.service.js.
  trashRetentionDays: int('TRASH_RETENTION_DAYS', 30),
  minio: {
    endPoint: process.env.MINIO_ENDPOINT || 'localhost',
    port: int('MINIO_PORT', 9000),
    useSSL: bool('MINIO_USE_SSL', false),
    accessKey: required('MINIO_ACCESS_KEY'),
    secretKey: required('MINIO_SECRET_KEY'),
    bucket: process.env.MINIO_BUCKET || 'uploads',
    publicEndpoint: process.env.MINIO_PUBLIC_ENDPOINT || null,
  },
};
