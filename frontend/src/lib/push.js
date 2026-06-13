// Task5 #7 — Web Push client helpers. Subscribes the browser's PushManager to
// the server's VAPID key and registers the subscription with the backend.
// Requires a registered service worker (PROD builds / localhost) and a secure
// context — degrades gracefully (getPushState reports `supported:false`).
import { api } from '../api/client.js';

export function pushSupported() {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

// VAPID public keys are base64url; PushManager wants a Uint8Array.
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

async function getRegistration() {
  if (!('serviceWorker' in navigator)) return null;
  // Resolves once a SW controls the page (won't resolve if none is registered,
  // e.g. the Vite dev server — guard callers with a race/try elsewhere).
  return navigator.serviceWorker.ready;
}

export async function getPushState() {
  if (!pushSupported()) return { supported: false, subscribed: false, permission: 'default' };
  const reg = await getRegistration().catch(() => null);
  const sub = reg ? await reg.pushManager.getSubscription().catch(() => null) : null;
  return { supported: true, subscribed: !!sub, permission: Notification.permission };
}

export async function serverPushEnabled() {
  try {
    const { enabled } = await api.get('/push/vapid-public-key').then((r) => r.data);
    return !!enabled;
  } catch {
    return false;
  }
}

export async function enablePush() {
  if (!pushSupported()) throw new Error('unsupported');
  const { key, enabled } = await api.get('/push/vapid-public-key').then((r) => r.data);
  if (!enabled || !key) throw new Error('not-configured');
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('denied');
  const reg = await getRegistration();
  if (!reg) throw new Error('no-sw');
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(key),
    });
  }
  await api.post('/push/subscribe', { subscription: sub.toJSON() });
  return true;
}

export async function disablePush() {
  const reg = await getRegistration().catch(() => null);
  const sub = reg ? await reg.pushManager.getSubscription().catch(() => null) : null;
  if (sub) {
    await api.post('/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => {});
    await sub.unsubscribe().catch(() => {});
  }
  return true;
}
