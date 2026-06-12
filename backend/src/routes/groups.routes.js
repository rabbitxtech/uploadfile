// Task5 #14 — teams. Admins create groups and manage membership; any user can
// list groups (name + member count) so they can share a file/folder to a team.
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../config/prisma.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { asyncHandler } from '../utils/async.js';
import { badRequest, notFound } from '../utils/errors.js';
import { notify } from '../services/notify.service.js';
import { audit, clientIp } from '../services/audit.service.js';

const router = Router();
router.use(requireAuth);

const publicUser = (u) => ({ id: u.id, name: u.name, email: u.email });

// List groups. Members are included only for admins (they manage them);
// regular users just need the names to pick a share target.
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const groups = await prisma.group.findMany({
      orderBy: { name: 'asc' },
      include: {
        members: { include: { user: { select: { id: true, name: true, email: true } } } },
      },
    });
    const isAdmin = req.user.role === 'admin';
    res.json({
      groups: groups.map((g) => ({
        id: g.id,
        name: g.name,
        createdAt: g.createdAt,
        memberCount: g.members.length,
        members: isAdmin ? g.members.map((m) => publicUser(m.user)) : undefined,
      })),
    });
  }),
);

router.post(
  '/',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const { name } = z.object({ name: z.string().trim().min(1).max(80) }).parse(req.body);
    const exists = await prisma.group.findUnique({ where: { name } });
    if (exists) throw badRequest('A group with that name already exists');
    const group = await prisma.group.create({ data: { name } });
    audit('group_create', { userId: req.user.id, targetType: 'group', targetId: group.id, meta: { name }, ip: clientIp(req) });
    res.status(201).json({ id: group.id, name: group.name, memberCount: 0, members: [] });
  }),
);

router.patch(
  '/:id',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const { name } = z.object({ name: z.string().trim().min(1).max(80) }).parse(req.body);
    const group = await prisma.group.findUnique({ where: { id: req.params.id } });
    if (!group) throw notFound('Group');
    const clash = await prisma.group.findUnique({ where: { name } });
    if (clash && clash.id !== group.id) throw badRequest('A group with that name already exists');
    const updated = await prisma.group.update({ where: { id: group.id }, data: { name } });
    audit('group_rename', { userId: req.user.id, targetType: 'group', targetId: group.id, meta: { from: group.name, to: name }, ip: clientIp(req) });
    res.json({ id: updated.id, name: updated.name });
  }),
);

// Deleting a group cascades its memberships and grants (FK onDelete: Cascade).
router.delete(
  '/:id',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const group = await prisma.group.findUnique({ where: { id: req.params.id } });
    if (!group) throw notFound('Group');
    await prisma.group.delete({ where: { id: group.id } });
    audit('group_delete', { userId: req.user.id, targetType: 'group', targetId: group.id, meta: { name: group.name }, ip: clientIp(req) });
    res.json({ ok: true });
  }),
);

// Add a member by username/email.
router.post(
  '/:id/members',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const { identifier } = z.object({ identifier: z.string().trim().min(1) }).parse(req.body);
    const group = await prisma.group.findUnique({ where: { id: req.params.id } });
    if (!group) throw notFound('Group');
    const user = await prisma.user.findUnique({ where: { email: identifier } });
    if (!user) throw notFound('User');
    await prisma.groupMember.upsert({
      where: { groupId_userId: { groupId: group.id, userId: user.id } },
      update: {},
      create: { groupId: group.id, userId: user.id },
    });
    audit('group_member_add', { userId: req.user.id, targetType: 'group', targetId: group.id, meta: { member: user.email }, ip: clientIp(req) });
    notify(user.id, {
      type: 'group_added',
      title: `You were added to the group "${group.name}"`,
      body: 'Files and folders shared with this group are now visible to you.',
      link: '/shared-with-me',
    });
    res.status(201).json({ ok: true, user: publicUser(user) });
  }),
);

router.delete(
  '/:id/members/:userId',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const member = await prisma.groupMember.findUnique({
      where: { groupId_userId: { groupId: req.params.id, userId: req.params.userId } },
    });
    if (!member) throw notFound('Membership');
    await prisma.groupMember.delete({ where: { id: member.id } });
    audit('group_member_remove', { userId: req.user.id, targetType: 'group', targetId: req.params.id, meta: { member: req.params.userId }, ip: clientIp(req) });
    res.json({ ok: true });
  }),
);

export default router;

