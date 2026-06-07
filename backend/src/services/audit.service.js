// B6 — best-effort audit logging. Never throws (logging must not break flows).
import { prisma } from '../config/prisma.js';
import { logger } from '../config/logger.js';

export function clientIp(req) {
  return (
    (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.ip ||
    req.socket?.remoteAddress ||
    null
  );
}

export function audit(action, { userId = null, targetType = null, targetId = null, meta = null, ip = null } = {}) {
  prisma.auditLog
    .create({
      data: {
        action,
        userId,
        targetType,
        targetId,
        meta: meta ? JSON.stringify(meta).slice(0, 2000) : null,
        ip,
      },
    })
    .catch((e) => logger.warn({ err: e?.message }, '[audit] failed'));
}
