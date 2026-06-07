// B8 — personal access tokens (API keys).
import crypto from 'crypto';
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../config/prisma.js';
import { requireAuth, API_KEY_PREFIX, hashApiKey } from '../middleware/auth.js';
import { asyncHandler } from '../utils/async.js';
import { notFound } from '../utils/errors.js';
import { audit, clientIp } from '../services/audit.service.js';

const router = Router();
router.use(requireAuth);

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const keys = await prisma.apiKey.findMany({
      where: { userId: req.user.id },
      orderBy: { createdAt: 'desc' },
      select: { id: true, name: true, prefix: true, lastUsedAt: true, revokedAt: true, createdAt: true },
    });
    res.json({ keys });
  }),
);

router.post(
  '/',
  asyncHandler(async (req, res) => {
    const { name } = z.object({ name: z.string().trim().min(1).max(80) }).parse(req.body);
    const secret = API_KEY_PREFIX + crypto.randomBytes(24).toString('base64url');
    const prefix = secret.slice(0, 10);
    const created = await prisma.apiKey.create({
      data: { userId: req.user.id, name, prefix, hash: hashApiKey(secret) },
      select: { id: true, name: true, prefix: true, createdAt: true },
    });
    audit('apikey_create', { userId: req.user.id, targetType: 'apikey', targetId: created.id, meta: { name }, ip: clientIp(req) });
    // The full secret is returned exactly once.
    res.status(201).json({ ...created, key: secret });
  }),
);

router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const key = await prisma.apiKey.findFirst({ where: { id: req.params.id, userId: req.user.id } });
    if (!key) throw notFound('API key');
    await prisma.apiKey.update({ where: { id: key.id }, data: { revokedAt: new Date() } });
    audit('apikey_revoke', { userId: req.user.id, targetType: 'apikey', targetId: key.id, ip: clientIp(req) });
    res.json({ ok: true });
  }),
);

export default router;
