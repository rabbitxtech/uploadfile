// Admin user management + self profile.
import { Router } from 'express';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { prisma } from '../config/prisma.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { asyncHandler } from '../utils/async.js';
import { badRequest, notFound } from '../utils/errors.js';
import { env } from '../config/env.js';
import { notify } from '../services/notify.service.js';
import { audit, clientIp } from '../services/audit.service.js';
import { revokeUserSessions } from '../services/session.service.js';
import { removePrefix } from '../services/storage.service.js';
import { removeHls } from '../services/hls.service.js';

const router = Router();
router.use(requireAuth);

function publicUser(u) {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
    banned: u.banned,
    approved: u.approved,
    emailVerified: u.emailVerified,
    totpEnabled: u.totpEnabled,
    quotaBytes: u.quotaBytes.toString(),
    usedBytes: u.usedBytes.toString(),
    createdAt: u.createdAt,
  };
}

// Update own profile / password
router.patch(
  '/me',
  asyncHandler(async (req, res) => {
    const data = z
      .object({
        name: z.string().min(1).max(120).optional(),
        password: z.string().min(6).optional(),
      })
      .parse(req.body);

    const u = await prisma.user.update({
      where: { id: req.user.id },
      data: {
        name: data.name ?? undefined,
        password: data.password ? await bcrypt.hash(data.password, 10) : undefined,
      },
    });
    // Changing your password logs out every other device but keeps you signed in
    // here (Task 2).
    if (data.password) {
      await revokeUserSessions(req.user.id, req.sessionId);
      audit('password_change', { userId: req.user.id, ip: clientIp(req) });
    }
    res.json({ user: publicUser(u) });
  }),
);

// ---- admin ----
router.get(
  '/',
  requireRole('admin'),
  asyncHandler(async (_req, res) => {
    const users = await prisma.user.findMany({ orderBy: { createdAt: 'asc' } });
    res.json({ users: users.map(publicUser) });
  }),
);

// Admin creates a user
router.post(
  '/',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const IDENT_RE = /^[a-zA-Z0-9._-]+$/;
    const data = z
      .object({
        email: z
          .string()
          .trim()
          .min(3)
          .max(255)
          .refine(
            (v) => IDENT_RE.test(v) || z.string().email().safeParse(v).success,
            'Only letters, numbers, dot, underscore, hyphen — or a valid email',
          ),
        password: z.string().min(6),
        name: z.string().max(120).optional(),
        role: z.enum(['admin', 'user']).default('user'),
        quotaBytes: z.union([z.string(), z.number()]).optional(),
      })
      .parse(req.body);
    const exists = await prisma.user.findUnique({ where: { email: data.email } });
    if (exists) throw badRequest('Username already taken');
    const u = await prisma.user.create({
      data: {
        email: data.email,
        password: await bcrypt.hash(data.password, 10),
        name: data.name ?? null,
        role: data.role,
        emailVerified: true, // admin-created accounts are pre-verified
        approved: true, // ...and pre-approved (an admin created them)
        quotaBytes:
          data.quotaBytes !== undefined ? BigInt(data.quotaBytes) : env.defaultQuotaBytes,
      },
    });
    notify(u.id, {
      type: 'welcome',
      title: `Welcome, ${u.name || u.email}`,
      body: `Your account was created by an administrator.`,
      link: '/profile',
    });
    res.status(201).json({ user: publicUser(u) });
  }),
);

router.patch(
  '/:id',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const data = z
      .object({
        name: z.string().min(1).max(120).optional(),
        role: z.enum(['admin', 'user']).optional(),
        quotaBytes: z.union([z.string(), z.number()]).optional(),
        banned: z.boolean().optional(),
        approved: z.boolean().optional(),
        password: z.string().min(6).optional(),
      })
      .parse(req.body);
    const quotaBytes =
      data.quotaBytes !== undefined ? BigInt(data.quotaBytes) : undefined;

    const u = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (!u) throw notFound('User');
    // Don't let an admin ban themselves out of their own account
    if (data.banned === true && u.id === req.user.id) {
      throw badRequest('Cannot ban yourself');
    }

    const updated = await prisma.user.update({
      where: { id: u.id },
      data: {
        name: data.name ?? undefined,
        role: data.role ?? undefined,
        quotaBytes: quotaBytes ?? undefined,
        banned: data.banned ?? undefined,
        approved: data.approved ?? undefined,
        password: data.password ? await bcrypt.hash(data.password, 10) : undefined,
      },
    });
    // Notify the target user about admin-driven changes (skip if they did the
    // change to themselves)
    if (updated.id !== req.user.id) {
      if (data.banned === true && !u.banned) {
        notify(updated.id, {
          type: 'banned',
          title: 'Your account has been banned',
          body: 'Contact an administrator if you believe this is a mistake.',
        });
      } else if (data.banned === false && u.banned) {
        notify(updated.id, {
          type: 'unbanned',
          title: 'Your account has been reinstated',
          body: 'You can log in again.',
          link: '/login',
        });
      }
      if (data.approved === true && !u.approved) {
        notify(updated.id, {
          type: 'approved',
          title: 'Your account has been approved',
          body: 'You can now upload files. Welcome aboard!',
          link: '/files',
        });
      }
      if (data.role && data.role !== u.role) {
        notify(updated.id, {
          type: 'role_changed',
          title: `Your role was changed to "${data.role}"`,
          link: '/profile',
        });
      }
      if (quotaBytes !== undefined && quotaBytes !== u.quotaBytes) {
        const gb = (Number(quotaBytes) / 1024 / 1024 / 1024).toFixed(2);
        notify(updated.id, {
          type: 'quota_changed',
          title: `Your storage quota was updated to ${gb} GB`,
          link: '/profile',
        });
      }
      // B6 — audit admin-driven account changes.
      const ip = clientIp(req);
      if (data.banned === true && !u.banned) audit('user_ban', { userId: req.user.id, targetType: 'user', targetId: u.id, ip });
      if (data.banned === false && u.banned) audit('user_unban', { userId: req.user.id, targetType: 'user', targetId: u.id, ip });
      if (data.role && data.role !== u.role) audit('user_role_change', { userId: req.user.id, targetType: 'user', targetId: u.id, meta: { role: data.role }, ip });
      if (quotaBytes !== undefined && quotaBytes !== u.quotaBytes) audit('user_quota_change', { userId: req.user.id, targetType: 'user', targetId: u.id, meta: { quotaBytes: quotaBytes.toString() }, ip });
      if (data.password) audit('user_password_reset', { userId: req.user.id, targetType: 'user', targetId: u.id, ip });
      if (data.approved === true && !u.approved) audit('user_approve', { userId: req.user.id, targetType: 'user', targetId: u.id, ip });
      if (data.approved === false && u.approved) audit('user_unapprove', { userId: req.user.id, targetType: 'user', targetId: u.id, ip });
    }
    // An admin resetting a user's password forces that user to sign in again on
    // all devices (Task 2).
    if (data.password) await revokeUserSessions(u.id);
    res.json({ user: publicUser(updated) });
  }),
);

router.delete(
  '/:id',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    if (req.params.id === req.user.id) {
      return res.status(400).json({ error: 'Cannot delete self' });
    }
    const target = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (!target) throw notFound('User');

    // Belt-and-braces on the admin count, NOT a reachable bug today: the
    // self-delete check above already means a caller can only ever target
    // another admin, which implies at least two exist. It is here because the
    // consequence of ever losing the last one is unrecoverable — the bootstrap
    // that grants `admin` is gated on `user.count() === 0`, so with any user
    // still present it can never fire again, leaving every requireRole('admin')
    // route permanently unreachable with no in-app way back. Anything that
    // weakens the self-check (a service token, a bulk-delete route) would make
    // this the only thing standing between an admin and that state.
    if (target.role === 'admin') {
      const admins = await prisma.user.count({ where: { role: 'admin' } });
      if (admins <= 1) throw badRequest('Cannot delete the last admin');
    }

    // Collect the object keys BEFORE deleting: `File.owner` is onDelete Cascade,
    // so the File/FileVersion rows — the only record of which MinIO objects
    // exist — vanish with the user. Deleting the rows without the objects leaves
    // storage that nothing can ever attribute or reclaim, the same
    // unreconcilable drift the version-sum refunds exist to prevent. HLS
    // renditions are keyed by fileId (not userId), so they need the ids read out
    // here; the file and thumbnail objects are both per-user prefixes.
    const files = await prisma.file.findMany({
      where: { ownerId: target.id },
      select: { id: true },
    });

    await prisma.user.delete({ where: { id: target.id } });
    audit('user_delete', { userId: req.user.id, targetType: 'user', targetId: target.id, ip: clientIp(req) });

    // Best-effort and detached: the account is already gone, and a storage
    // hiccup must not turn a completed deletion into a 500 that invites a retry
    // against a user that no longer exists.
    (async () => {
      await removePrefix(`u/${target.id}/`);
      await removePrefix(`t/${target.id}/`);
      for (const f of files) await removeHls(f.id);
    })().catch((e) => console.warn('[users] object cleanup after delete failed:', e?.message));

    res.json({ ok: true });
  }),
);

export default router;
