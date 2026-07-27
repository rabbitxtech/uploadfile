// Task5 #7 — Web Push subscription management (PWA).
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../config/prisma.js';
import { env } from '../config/env.js';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../utils/async.js';
import { assertPushEndpoint } from '../utils/ssrf.js';
import { conflict } from '../utils/errors.js';

const router = Router();

// Public: the browser needs the VAPID public key to create a subscription, and
// to know whether push is configured at all (so the UI can hide the toggle).
router.get('/vapid-public-key', (req, res) => {
  res.json({ key: env.webPush.publicKey || null, enabled: env.webPush.enabled });
});

router.use(requireAuth);

const subSchema = z.object({
  endpoint: z.string().url(),
  keys: z.object({ p256dh: z.string().min(1), auth: z.string().min(1) }),
});

// Register (or refresh) this browser's push endpoint for the current user.
router.post(
  '/subscribe',
  asyncHandler(async (req, res) => {
    const sub = subSchema.parse(req.body?.subscription ?? req.body);
    // SSRF guard: the server POSTs to this endpoint via web-push, so reject
    // non-https / localhost / private / cloud-metadata targets.
    await assertPushEndpoint(sub.endpoint);
    const data = {
      userId: req.user.id,
      endpoint: sub.endpoint,
      p256dh: sub.keys.p256dh,
      auth: sub.keys.auth,
      userAgent: (req.headers['user-agent'] || '').slice(0, 255) || null,
    };
    // `endpoint` is globally unique, and the update branch used to write
    // `userId` — so the ENDPOINT, not the account, decided who a subscription
    // belonged to, and whichever caller presented it last won. That is a
    // redirect of someone else's notifications: sendPush() loads every row for a
    // user and delivers the notification's title and body verbatim, and those
    // carry real content (the file name on a share or drop-box upload, the first
    // 120 characters of a comment or @mention, a group name, a ban or approval).
    // Flip the row's owner and the victim's browser silently stops receiving
    // them while the claimant's starts, with nothing telling either side and no
    // screen anywhere that lists who a subscription belongs to.
    //
    // So a row is claimed once and then belongs to that account. The ordinary
    // re-subscribe (same user, rotated keys) still updates in place; a browser
    // that genuinely changes hands moves over only after the previous owner
    // releases it via POST /unsubscribe, which is already scoped to their own
    // userId. Note the update is a conditional `updateMany` on (endpoint,
    // userId) rather than an upsert: the endpoint's uniqueness means two callers
    // racing here are serialised on that one row, so the loser sees 0 rows
    // updated and gets the same 409 a plainly-taken endpoint gives.
    const updated = await prisma.pushSubscription.updateMany({
      where: { endpoint: sub.endpoint, userId: req.user.id },
      data: { p256dh: data.p256dh, auth: data.auth, userAgent: data.userAgent },
    });
    if (updated.count === 0) {
      try {
        await prisma.pushSubscription.create({ data });
      } catch {
        // Unique violation on `endpoint`: another account holds it.
        throw conflict('That push endpoint is registered to another account');
      }
    }
    res.status(201).json({ ok: true });
  }),
);

// Remove this browser's endpoint (called on disable / logout).
router.post(
  '/unsubscribe',
  asyncHandler(async (req, res) => {
    const endpoint = z.string().url().parse(req.body?.endpoint);
    await prisma.pushSubscription.deleteMany({ where: { endpoint, userId: req.user.id } });
    res.json({ ok: true });
  }),
);

export default router;
