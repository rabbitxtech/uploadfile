// Task5 #7 — Web Push delivery (PWA). Best-effort sibling of the in-app
// notification: notify.service calls sendPush() after it inserts the row, so
// every notification trigger (share/grant, comment/@mention, admin approve,
// group add, share download…) reaches the browser even when no tab is open.
//
// VAPID keys authenticate us to the push services; without them push is a no-op.
// Subscriptions whose endpoint is gone (404/410) are pruned automatically.
import webpush from 'web-push';
import { env } from '../config/env.js';
import { prisma } from '../config/prisma.js';
import { logger } from '../config/logger.js';

let configured = false;
function ensureConfigured() {
  if (configured || !env.webPush.enabled) return env.webPush.enabled;
  webpush.setVapidDetails(env.webPush.subject, env.webPush.publicKey, env.webPush.privateKey);
  configured = true;
  return true;
}

// Fire a push to every device the user has registered. Never throws.
export async function sendPush(userId, payload) {
  if (!userId || !ensureConfigured()) return;
  let subs;
  try {
    subs = await prisma.pushSubscription.findMany({ where: { userId } });
  } catch (e) {
    logger.warn({ err: e?.message }, '[push] load subscriptions failed');
    return;
  }
  if (!subs.length) return;

  const body = JSON.stringify({
    title: payload.title || 'Uploader',
    body: payload.body || '',
    link: payload.link || '/',
    type: payload.type || 'notification',
  });

  await Promise.all(
    subs.map(async (s) => {
      const subscription = {
        endpoint: s.endpoint,
        keys: { p256dh: s.p256dh, auth: s.auth },
      };
      try {
        await webpush.sendNotification(subscription, body);
      } catch (err) {
        // 404/410 = the browser dropped this subscription; clean it up so we
        // stop trying. Other errors (network, 5xx) are transient — leave them.
        const code = err?.statusCode;
        if (code === 404 || code === 410) {
          await prisma.pushSubscription.delete({ where: { id: s.id } }).catch(() => {});
        } else {
          logger.warn({ err: err?.message, code }, '[push] send failed');
        }
      }
    }),
  );
}
