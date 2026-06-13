// Task5 #7 — push.service: VAPID gating + pruning gone subscriptions.
import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.mock factories are hoisted above imports, so the shared mocks must be
// created with vi.hoisted (also hoisted) rather than plain top-level consts.
const h = vi.hoisted(() => ({
  sendNotification: vi.fn(),
  setVapidDetails: vi.fn(),
  findMany: vi.fn(),
  del: vi.fn(),
  env: { webPush: { enabled: true, subject: 'mailto:a@b.c', publicKey: 'pub', privateKey: 'priv' } },
}));
const { sendNotification, setVapidDetails, findMany, del, env } = h;

vi.mock('web-push', () => ({ default: { setVapidDetails: h.setVapidDetails, sendNotification: h.sendNotification } }));
vi.mock('../src/config/env.js', () => ({ env: h.env }));
vi.mock('../src/config/prisma.js', () => ({
  prisma: { pushSubscription: { findMany: (...a) => h.findMany(...a), delete: (...a) => h.del(...a) } },
}));
vi.mock('../src/config/logger.js', () => ({ logger: { warn: vi.fn() } }));

import { sendPush } from '../src/services/push.service.js';

beforeEach(() => {
  sendNotification.mockReset();
  setVapidDetails.mockReset();
  findMany.mockReset();
  del.mockReset();
  env.webPush.enabled = true;
});

describe('sendPush', () => {
  it('does nothing (and never touches web-push) when VAPID is not configured', async () => {
    env.webPush.enabled = false;
    await sendPush('u1', { title: 'hi' });
    expect(findMany).not.toHaveBeenCalled();
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it('sends to every subscription with an encrypted JSON payload', async () => {
    findMany.mockResolvedValue([
      { id: 's1', endpoint: 'https://push/1', p256dh: 'a', auth: 'b' },
      { id: 's2', endpoint: 'https://push/2', p256dh: 'c', auth: 'd' },
    ]);
    sendNotification.mockResolvedValue({});
    await sendPush('u1', { title: 'T', body: 'B', link: '/files', type: 'mention' });
    expect(sendNotification).toHaveBeenCalledTimes(2);
    const [sub, body] = sendNotification.mock.calls[0];
    expect(sub).toEqual({ endpoint: 'https://push/1', keys: { p256dh: 'a', auth: 'b' } });
    expect(JSON.parse(body)).toEqual({ title: 'T', body: 'B', link: '/files', type: 'mention' });
  });

  it('prunes a subscription when the endpoint is gone (410)', async () => {
    findMany.mockResolvedValue([{ id: 'dead', endpoint: 'https://push/x', p256dh: 'a', auth: 'b' }]);
    sendNotification.mockRejectedValue({ statusCode: 410 });
    del.mockResolvedValue({});
    await sendPush('u1', { title: 'T' });
    expect(del).toHaveBeenCalledWith({ where: { id: 'dead' } });
  });

  it('keeps the subscription on a transient error (5xx)', async () => {
    findMany.mockResolvedValue([{ id: 'keep', endpoint: 'https://push/y', p256dh: 'a', auth: 'b' }]);
    sendNotification.mockRejectedValue({ statusCode: 500 });
    await sendPush('u1', { title: 'T' });
    expect(del).not.toHaveBeenCalled();
  });

  it('skips when the user has no subscriptions', async () => {
    findMany.mockResolvedValue([]);
    await sendPush('u1', { title: 'T' });
    expect(sendNotification).not.toHaveBeenCalled();
  });
});
