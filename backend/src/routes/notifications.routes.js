// Per-user notification inbox.
import { Router } from 'express';
import { prisma } from '../config/prisma.js';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../utils/async.js';
import { notFound } from '../utils/errors.js';

const router = Router();
router.use(requireAuth);

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const limit = Math.min(parseInt(String(req.query.limit || '50'), 10) || 50, 200);
    const unreadOnly = req.query.unread === '1' || req.query.unread === 'true';
    const where = { userId: req.user.id };
    if (unreadOnly) where.readAt = null;
    const [items, unread] = await Promise.all([
      prisma.notification.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit,
      }),
      prisma.notification.count({ where: { userId: req.user.id, readAt: null } }),
    ]);
    res.json({ items, unread });
  }),
);

router.post(
  '/:id/read',
  asyncHandler(async (req, res) => {
    const n = await prisma.notification.findFirst({
      where: { id: req.params.id, userId: req.user.id },
    });
    if (!n) throw notFound('Notification');
    if (!n.readAt) {
      await prisma.notification.update({
        where: { id: n.id },
        data: { readAt: new Date() },
      });
    }
    res.json({ ok: true });
  }),
);

router.post(
  '/mark-all-read',
  asyncHandler(async (req, res) => {
    const r = await prisma.notification.updateMany({
      where: { userId: req.user.id, readAt: null },
      data: { readAt: new Date() },
    });
    res.json({ count: r.count });
  }),
);

router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const n = await prisma.notification.findFirst({
      where: { id: req.params.id, userId: req.user.id },
    });
    if (!n) throw notFound('Notification');
    await prisma.notification.delete({ where: { id: n.id } });
    res.json({ ok: true });
  }),
);

router.post(
  '/clear',
  asyncHandler(async (req, res) => {
    const r = await prisma.notification.deleteMany({ where: { userId: req.user.id } });
    res.json({ count: r.count });
  }),
);

export default router;
