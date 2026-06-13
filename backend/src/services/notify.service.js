import { prisma } from '../config/prisma.js';
import { pushToUser } from '../realtime/bus.js';
import { sendPush } from './push.service.js';

// Best-effort notification creation — never throw to the caller; trigger sites
// (downloads, admin actions) shouldn't fail because the notification insert
// hiccuped.
export async function notify(userId, payload) {
  if (!userId) return;
  try {
    await prisma.notification.create({
      data: {
        userId,
        type: payload.type,
        title: payload.title,
        body: payload.body ?? null,
        link: payload.link ?? null,
      },
    });
    // Task5 #5 — nudge the user's open tabs to refetch instead of waiting for
    // the slow poll. The row is already committed, so just signal.
    pushToUser(userId, { type: 'notification' });
    // Task5 #7 — also deliver a Web Push so the user is reached when no tab is
    // open. Best-effort and detached (don't make notify() await network I/O).
    sendPush(userId, payload).catch(() => {});
  } catch (e) {
    console.warn('[notify] failed:', e?.message);
  }
}
