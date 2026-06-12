// Task5 #5 — server→client push over the existing /ws socket.
//
// presence.js registers every authenticated socket here (one user can have
// several sockets — tabs/devices). Trigger sites call pushToUser / emitFileChange
// fire-and-forget; if the user has no open socket the event is simply dropped —
// the client's slow poll (NotificationBell) and refetch-on-focus are the
// fallback, so delivery here is best-effort by design.
const sockets = new Map(); // userId -> Set<ws>

export function registerSocket(userId, ws) {
  if (!sockets.has(userId)) sockets.set(userId, new Set());
  sockets.get(userId).add(ws);
}

export function unregisterSocket(userId, ws) {
  const set = sockets.get(userId);
  if (!set) return;
  set.delete(ws);
  if (set.size === 0) sockets.delete(userId);
}

export function pushToUser(userId, payload) {
  const set = sockets.get(userId);
  if (!set || set.size === 0) return;
  const msg = JSON.stringify(payload);
  for (const ws of set) {
    if (ws.readyState === ws.OPEN) {
      try {
        ws.send(msg);
      } catch {
        /* socket died mid-send — heartbeat will reap it */
      }
    }
  }
}

// A file list changed for this user (upload/rename/move/trash/restore) — the
// client invalidates its folder queries so other devices refresh live.
export function emitFileChange(userId, folderId = null) {
  pushToUser(userId, { type: 'file-change', folderId });
}

// Test/diagnostics helper.
export function connectedUserCount() {
  return sockets.size;
}
