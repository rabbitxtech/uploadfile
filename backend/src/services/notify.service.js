import { prisma } from '../config/prisma.js';

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
  } catch (e) {
    console.warn('[notify] failed:', e?.message);
  }
}
