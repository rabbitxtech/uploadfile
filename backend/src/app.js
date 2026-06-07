import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import swaggerUi from 'swagger-ui-express';
import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { openapiDocument } from './openapi.js';
import { errorHandler, notFoundHandler } from './middleware/error.js';

import authRoutes from './routes/auth.routes.js';
import folderRoutes from './routes/folders.routes.js';
import fileRoutes from './routes/files.routes.js';
import uploadRoutes from './routes/upload.routes.js';
import shareRoutes from './routes/shares.routes.js';
import trashRoutes from './routes/trash.routes.js';
import userRoutes from './routes/users.routes.js';
import notificationRoutes from './routes/notifications.routes.js';
import grantRoutes from './routes/grants.routes.js';
import collectionRoutes from './routes/collections.routes.js';
import webdavRoutes from './routes/webdav.routes.js';
import keyRoutes from './routes/keys.routes.js';
import auditRoutes from './routes/audit.routes.js';

export function buildApp() {
  const app = express();

  // Behind nginx: trust the first proxy so req.ip / rate-limit use the real
  // client IP from X-Forwarded-For (B5).
  app.set('trust proxy', 1);

  // Content-Security-Policy (Task 3). The SPA's HTML is served by nginx, so this
  // CSP applies to API JSON, the Swagger UI, and WebDAV responses. `'unsafe-inline'`
  // is required for swagger-ui's inline styles/scripts; `upgrade-insecure-requests`
  // is disabled (null) so the dev stack works over plain HTTP. `crossOriginResourcePolicy`
  // stays off because media is served cross-origin in dev / via presigned URLs.
  app.use(
    helmet({
      crossOriginResourcePolicy: false,
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          'default-src': ["'self'"],
          'script-src': ["'self'", "'unsafe-inline'"],
          'style-src': ["'self'", "'unsafe-inline'"],
          'img-src': ["'self'", 'data:', 'blob:'],
          'connect-src': ["'self'"],
          'object-src': ["'none'"],
          'frame-ancestors': ["'self'"],
          'base-uri': ["'self'"],
          'upgrade-insecure-requests': null,
        },
      },
    }),
  );

  // WebDAV is mounted before CORS so its OPTIONS (with the DAV header) isn't
  // short-circuited by the cors() preflight responder. It does its own auth.
  app.use('/webdav', webdavRoutes);

  app.use(
    cors({
      origin: (origin, cb) => {
        if (!origin) return cb(null, true);
        if (env.corsOrigin.includes('*') || env.corsOrigin.includes(origin)) return cb(null, true);
        cb(new Error('CORS blocked: ' + origin));
      },
      credentials: true,
    }),
  );
  // Structured request logging. autoLogging skips the noisy health check.
  app.use(
    pinoHttp({
      logger,
      autoLogging: { ignore: (req) => req.url === '/health' },
      // Don't log the JWT or cookies.
      redact: ['req.headers.authorization', 'req.headers.cookie'],
    }),
  );
  app.use(express.json({ limit: '2mb' }));

  app.get('/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));

  // API docs (Swagger UI + raw OpenAPI JSON).
  app.get('/api/openapi.json', (_req, res) => res.json(openapiDocument));
  app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(openapiDocument, { customSiteTitle: 'Uploader API' }));

  app.use('/api/auth', authRoutes);
  app.use('/api/folders', folderRoutes);
  app.use('/api/files', fileRoutes);
  app.use('/api/upload', uploadRoutes);
  app.use('/api/shares', shareRoutes);
  app.use('/api/trash', trashRoutes);
  app.use('/api/users', userRoutes);
  app.use('/api/notifications', notificationRoutes);
  app.use('/api/grants', grantRoutes);
  app.use('/api/collections', collectionRoutes);
  app.use('/api/keys', keyRoutes);
  app.use('/api/audit', auditRoutes);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
