// B6 — admin view of the audit log.
import { Router } from 'express';
import { prisma } from '../config/prisma.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { asyncHandler } from '../utils/async.js';

const router = Router();
router.use(requireAuth, requireRole('admin'));

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const take = Math.min(200, Number(req.query.limit) || 100);
    const action = req.query.action ? String(req.query.action) : null;
    const logs = await prisma.auditLog.findMany({
      where: action ? { action } : {},
      orderBy: { createdAt: 'desc' },
      take,
      include: { user: { select: { id: true, name: true, email: true } } },
    });
    res.json({
      logs: logs.map((l) => ({
        id: l.id,
        action: l.action,
        targetType: l.targetType,
        targetId: l.targetId,
        meta: l.meta ? JSON.parse(l.meta) : null,
        ip: l.ip,
        createdAt: l.createdAt,
        user: l.user,
      })),
    });
  }),
);

export default router;
