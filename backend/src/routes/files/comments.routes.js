// File comments — visible to anyone with READ access (owner, admin, grantee),
// so these go through readableFile() rather than an ownership filter.
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../config/prisma.js';
import { asyncHandler } from '../../utils/async.js';
import { notFound } from '../../utils/errors.js';
import { notify } from '../../services/notify.service.js';
import { readableFile } from './_shared.js';

export const commentsRouter = Router();

commentsRouter.get(
  '/:id/comments',
  asyncHandler(async (req, res) => {
    const { file } = await readableFile(req);
    if (!file) throw notFound('File');
    const comments = await prisma.comment.findMany({
      where: { fileId: file.id },
      orderBy: { createdAt: 'asc' },
      include: { user: { select: { id: true, name: true, email: true } } },
    });
    res.json({ comments });
  }),
);

commentsRouter.post(
  '/:id/comments',
  asyncHandler(async (req, res) => {
    const { body } = z.object({ body: z.string().trim().min(1).max(2000) }).parse(req.body);
    const { file } = await readableFile(req);
    if (!file) throw notFound('File');
    const comment = await prisma.comment.create({
      data: { fileId: file.id, userId: req.user.id, body },
      include: { user: { select: { id: true, name: true, email: true } } },
    });
    // Notify the file owner (if someone else commented)
    if (file.ownerId !== req.user.id) {
      notify(file.ownerId, {
        type: 'comment',
        title: `${req.user.name || req.user.email} commented on "${file.name}"`,
        body: body.slice(0, 120),
        link: '/files',
      });
    }
    // I3 — notify @mentioned users (by username/email), excluding self + owner
    // (owner already notified above) and de-duplicated.
    const mentions = [...new Set((body.match(/@([a-zA-Z0-9._-]+)/g) || []).map((m) => m.slice(1)))];
    if (mentions.length) {
      const users = await prisma.user.findMany({
        where: { email: { in: mentions } },
        select: { id: true },
      });
      const already = new Set([req.user.id, file.ownerId]);
      for (const u of users) {
        if (already.has(u.id)) continue;
        already.add(u.id);
        notify(u.id, {
          type: 'mention',
          title: `${req.user.name || req.user.email} mentioned you on "${file.name}"`,
          body: body.slice(0, 120),
          link: '/files',
        });
      }
    }
    res.status(201).json(comment);
  }),
);

// Delete a comment (author, file owner, or admin).
commentsRouter.delete(
  '/:id/comments/:cid',
  asyncHandler(async (req, res) => {
    const comment = await prisma.comment.findUnique({
      where: { id: req.params.cid },
      include: { file: { select: { ownerId: true } } },
    });
    // The comment must belong to the file in the path — otherwise a caller
    // could delete any comment by pairing it with a file they own.
    if (!comment || comment.fileId !== req.params.id) throw notFound('Comment');
    const allowed =
      comment.userId === req.user.id ||
      comment.file.ownerId === req.user.id ||
      req.user.role === 'admin';
    if (!allowed) throw notFound('Comment');
    await prisma.comment.delete({ where: { id: comment.id } });
    res.json({ ok: true });
  }),
);
