// I4 — real-time presence over WebSocket. Clients connect to /ws?token=<jwt>,
// then send {type:'join'|'leave', fileId}. The server keeps a room per file and
// broadcasts the de-duplicated list of viewing users to everyone in that room.
import { WebSocketServer } from 'ws';
import { prisma } from '../config/prisma.js';
import { logger } from '../config/logger.js';
import { authenticateWs } from './wsauth.js';
import { registerSocket, unregisterSocket } from './bus.js';
import { fileAccessLevel } from '../services/access.service.js';

/**
 * May this user see who else is viewing `fileId`?
 *
 * A presence room is not a neutral channel: `viewersOf` broadcasts every
 * member's { id, name, email } to every other member. Joining was gated on
 * nothing but "the socket authenticated" — no read check on the file at all —
 * so any logged-in user who had a file id could join that file's room and be
 * handed the name and email address of everyone else looking at it, for a file
 * they have no access to. File ids appear in share links and in URLs users
 * paste around, so obtaining one does not take an attack.
 *
 * Every other consumer of file identity resolves access through
 * access.service.js; this is the one that skipped it. Read access (any level)
 * is the right bar — presence is a read-side feature, and a view-only grantee
 * should still see co-viewers.
 *
 * Trashed files are excluded to match the rest of the read surface. Failing
 * closed on an error is deliberate: a room this check could not resolve must
 * not fall open to a broadcast of other users' addresses.
 */
async function canSeePresence(user, fileId) {
  try {
    const file = await prisma.file.findFirst({
      where: { id: fileId, trashedAt: null },
      select: { id: true, ownerId: true, folderId: true },
    });
    if (!file) return false;
    return !!(await fileAccessLevel(user, file));
  } catch (e) {
    logger.warn({ err: e?.message, fileId }, '[presence] access check failed; refusing join');
    return false;
  }
}

export function attachPresence(server) {
  const wss = new WebSocketServer({ noServer: true });
  const rooms = new Map(); // fileId -> Set<ws>

  function viewersOf(fileId) {
    const set = rooms.get(fileId);
    if (!set) return [];
    const byUser = new Map();
    for (const ws of set) if (ws.user) byUser.set(ws.user.id, ws.user);
    return [...byUser.values()];
  }

  function broadcast(fileId) {
    const set = rooms.get(fileId);
    if (!set) return;
    const msg = JSON.stringify({ type: 'presence', fileId, viewers: viewersOf(fileId) });
    for (const ws of set) if (ws.readyState === ws.OPEN) ws.send(msg);
  }

  function join(ws, fileId) {
    if (!rooms.has(fileId)) rooms.set(fileId, new Set());
    rooms.get(fileId).add(ws);
    ws.rooms.add(fileId);
    broadcast(fileId);
  }
  function leave(ws, fileId) {
    const set = rooms.get(fileId);
    if (!set) return;
    set.delete(ws);
    ws.rooms.delete(fileId);
    if (set.size === 0) rooms.delete(fileId);
    else broadcast(fileId);
  }

  wss.on('connection', (ws) => {
    ws.rooms = new Set();
    ws.isAlive = true;
    if (ws.user) registerSocket(ws.user.id, ws); // Task5 #5 — server push channel
    ws.on('pong', () => (ws.isAlive = true));
    ws.on('message', async (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (msg.type === 'join' && typeof msg.fileId === 'string' && msg.fileId) {
        // One active file per socket keeps the room set tidy. Leave first so a
        // refused join still drops the previous room rather than silently
        // keeping the socket subscribed to a file the client has navigated away
        // from.
        for (const f of [...ws.rooms]) if (f !== msg.fileId) leave(ws, f);
        if (!ws.authUser || !(await canSeePresence(ws.authUser, msg.fileId))) return;
        // The socket may have closed or re-joined elsewhere during the await.
        if (ws.readyState !== ws.OPEN || ws.rooms.has(msg.fileId)) return;
        join(ws, msg.fileId);
      } else if (msg.type === 'leave' && msg.fileId) {
        leave(ws, msg.fileId);
      }
    });
    ws.on('close', () => {
      for (const f of [...ws.rooms]) leave(ws, f);
      if (ws.user) unregisterSocket(ws.user.id, ws);
    });
    ws.on('error', () => {});
  });

  // Drop dead connections.
  const interval = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      try {
        ws.ping();
      } catch {
        /* ignore */
      }
    }
  }, 30000);
  wss.on('close', () => clearInterval(interval));

  server.on('upgrade', async (req, socket, head) => {
    let pathname, token;
    try {
      const u = new URL(req.url, 'http://localhost');
      pathname = u.pathname;
      token = u.searchParams.get('token');
    } catch {
      return socket.destroy();
    }
    if (pathname !== '/ws') return; // not a presence socket
    try {
      // Same contract as requireAuth: live session + a real session token only.
      // `role` is selected because the presence join now resolves file access
      // through fileAccessLevel, which reads it — without it every admin would
      // be evaluated as an ordinary user and refused rooms they can plainly see.
      const u = await authenticateWs(token, {
        id: true, name: true, email: true, role: true, banned: true,
      });
      if (!u) return socket.destroy();
      wss.handleUpgrade(req, socket, head, (ws) => {
        // `role` stays on the socket for the access check but is NOT part of
        // what gets broadcast — viewersOf() sends ws.user verbatim to the whole
        // room, so keep the wire shape to the three fields the UI renders.
        ws.user = { id: u.id, name: u.name, email: u.email };
        ws.authUser = { id: u.id, role: u.role };
        wss.emit('connection', ws, req);
      });
    } catch {
      socket.destroy();
    }
  });

  logger.info('WebSocket presence attached at /ws');
}
