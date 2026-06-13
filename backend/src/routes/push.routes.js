// Task5 #7 — Web Push subscription management (PWA).
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../config/prisma.js';
import { env } from '../config/env.js';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../utils/async.js';
import { assertPushEndpoint } from '../utils/ssrf.js';

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
    // Endpoint is unique: upsert so re-subscribing (or a subscription that
    // moved to another account on a shared device) just updates the owner/keys.
    await prisma.pushSubscription.upsert({
      where: { endpoint: sub.endpoint },
      create: data,
      update: { userId: data.userId, p256dh: data.p256dh, auth: data.auth, userAgent: data.userAgent },
    });
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
