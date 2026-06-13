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
  // Feature flag: when false, ZIP download (bulk + public folder-share) is
  // locked (403). Frontend hides the buttons via GET /api/config.
  zipDownloadEnabled: bool('ZIP_DOWNLOAD_ENABLED', true),
  // Task 15 — abuse / quota caps. `0` disables the cap (unlimited).
  limits: {
    // Max active share links a single user may own (admins exempt).
    maxSharesPerUser: int('MAX_SHARES_PER_USER', 200),
    // Max non-revoked API keys a single user may own (admins exempt).
    maxApiKeysPerUser: int('MAX_API_KEYS_PER_USER', 25),
    // Total anonymous uploads accepted by one drop-box share (counted from the
    // share-access log; 0 = unlimited).
    dropboxMaxUploadsPerShare: int('DROPBOX_MAX_UPLOADS_PER_SHARE', 50),
    // Max size of a single anonymous drop-box upload (bytes; 0 = use the global
    // 100 MB multer limit).
    dropboxMaxFileBytes: int('DROPBOX_MAX_FILE_BYTES', 0),
    // Throttle authenticated file downloads to N KB/s per connection (0 = off).
    // Applies to GET /api/files/:id/download only — not inline preview/stream.
    downloadKbps: int('DOWNLOAD_BANDWIDTH_KBPS', 0),
  },
  // Task5 #9 — background HLS transcode (720p/480p) for smooth adaptive
  // playback. CPU-heavy, so it's opt-in and only runs for videos at least
  // HLS_MIN_MB large (smaller files play fine via the plain Range stream).
  hls: {
    enabled: bool('HLS_ENABLED', false),
    minBytes: int('HLS_MIN_MB', 50) * 1024 * 1024,
  },
  // Task5 #10 — whisper.cpp speech-to-text for video/audio: produces a .vtt
  // subtitle sibling file and feeds the transcript into ocrText (search).
  // Opt-in (model download ~150 MB on first use, transcribe is CPU-heavy).
  whisper: {
    enabled: bool('WHISPER_ENABLED', false),
    model: process.env.WHISPER_MODEL || 'base',
    lang: process.env.WHISPER_LANG || 'auto',
    bin: process.env.WHISPER_BIN || 'whisper-cli',
  },
  // Task5 #7 — Web Push (PWA). VAPID keypair authenticates the server to the
  // browser push services. Generate once with `npx web-push generate-vapid-keys`.
  // Push is enabled only when both keys are set (otherwise it's a no-op).
  webPush: {
    publicKey: process.env.VAPID_PUBLIC_KEY || '',
    privateKey: process.env.VAPID_PRIVATE_KEY || '',
    subject: process.env.VAPID_SUBJECT || 'mailto:admin@example.com',
    get enabled() {
      return !!(this.publicKey && this.privateKey);
    },
  },
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
