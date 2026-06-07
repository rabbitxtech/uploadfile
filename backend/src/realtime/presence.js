// I4 — real-time presence over WebSocket. Clients connect to /ws?token=<jwt>,
// then send {type:'join'|'leave', fileId}. The server keeps a room per file and
// broadcasts the de-duplicated list of viewing users to everyone in that room.
import { WebSocketServer } from 'ws';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { prisma } from '../config/prisma.js';
import { logger } from '../config/logger.js';

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
    ws.on('pong', () => (ws.isAlive = true));
    ws.on('message', (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (msg.type === 'join' && msg.fileId) {
        // One active file per socket keeps the room set tidy.
        for (const f of [...ws.rooms]) if (f !== msg.fileId) leave(ws, f);
        join(ws, msg.fileId);
      } else if (msg.type === 'leave' && msg.fileId) {
        leave(ws, msg.fileId);
      }
    });
    ws.on('close', () => {
      for (const f of [...ws.rooms]) leave(ws, f);
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
    if (!token) return socket.destroy();
    try {
      const payload = jwt.verify(token, env.jwtSecret);
      const u = await prisma.user.findUnique({
        where: { id: payload.sub },
        select: { id: true, name: true, email: true, banned: true },
      });
      if (!u || u.banned) return socket.destroy();
      wss.handleUpgrade(req, socket, head, (ws) => {
        ws.user = { id: u.id, name: u.name, email: u.email };
        wss.emit('connection', ws, req);
      });
    } catch {
      socket.destroy();
    }
  });

  logger.info('WebSocket presence attached at /ws');
}
