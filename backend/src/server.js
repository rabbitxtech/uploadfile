import http from 'http';
import { buildApp } from './app.js';
import { env } from './config/env.js';
import { ensureBucket } from './config/minio.js';
import { logger } from './config/logger.js';
import { attachPresence } from './realtime/presence.js';
import { startRetentionJob } from './services/retention.service.js';

const WEAK_SECRETS = ['dev-secret-change-me', 'change-me-please-use-a-long-random-string'];

async function main() {
  if (WEAK_SECRETS.includes(env.jwtSecret) || env.jwtSecret.length < 32) {
    logger.warn(
      'SECURITY: JWT_SECRET is weak/default. Set a long random JWT_SECRET in production — ' +
        'anyone who knows it can forge auth tokens.',
    );
  }
  await ensureBucket();
  const app = buildApp();
  const server = http.createServer(app);
  attachPresence(server); // WebSocket presence at /ws
  startRetentionJob(); // Task 6 — auto-clean expired trash
  server.listen(env.port, () => {
    logger.info(`API listening on http://localhost:${env.port}`);
  });
}

main().catch((e) => {
  logger.error({ err: e }, 'Fatal startup error');
  process.exit(1);
});
