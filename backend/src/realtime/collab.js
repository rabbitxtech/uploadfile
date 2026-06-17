// Task5 #6 — collaborative text/markdown editing (Yjs CRDT) over WebSocket.
// A y-websocket server runs at /yjs/<fileId>: the docName IS the fileId, so each
// file is its own shared room. Only users with EDIT access may connect (the CRDT
// channel is bidirectional, so a read-only grantee must not be able to inject
// edits). The document is seeded from MinIO on first load (bindState); the live
// content is persisted to MinIO as FileVersions by the client (POST
// /files/:id/collab-save), so the y-websocket server itself stays a relay.
import { createRequire } from 'node:module';
import { WebSocketServer } from 'ws';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { prisma } from '../config/prisma.js';
import { logger } from '../config/logger.js';
import { getObjectStream } from '../services/storage.service.js';
import { fileAccessLevel, canEdit } from '../services/access.service.js';

const require = createRequire(import.meta.url);
// y-websocket's server helpers are CJS (named exports Node's ESM lexer misses).
const { setupWSConnection, setPersistence } = require('y-websocket/bin/utils');

const MAX_BYTES = 1024 * 1024; // only collaborate on text files up to 1 MB
const YTEXT_NAME = 'content'; // must match the client's ydoc.getText() name

async function readObjectText(key) {
  const stream = await getObjectStream(key);
  const chunks = [];
  for await (const c of stream) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

// Seed each freshly loaded doc from the current file content in MinIO. Runs once
// per doc (when the first client opens it); later opens re-seed from the latest
// saved content. Fire-and-forget inside y-websocket — the insert propagates to
// clients via the doc's update broadcast once it completes.
setPersistence({
  provider: 'minio',
  bindState: async (docName, ydoc) => {
    try {
      const file = await prisma.file.findUnique({ where: { id: docName } });
      if (!file || file.trashedAt || Number(file.size) > MAX_BYTES) return;
      const text = await readObjectText(file.objectKey).catch(() => '');
      const ytext = ydoc.getText(YTEXT_NAME);
      if (ytext.length === 0 && text) {
        ydoc.transact(() => ytext.insert(0, text));
      }
    } catch (e) {
      logger.warn({ err: e?.message, docName }, '[collab] seed failed');
    }
  },
  writeState: async () => {}, // saving is client-driven (collab-save → FileVersion)
});

export function attachCollab(server) {
  const wss = new WebSocketServer({ noServer: true });

  wss.on('connection', (ws, req, docName) => {
    setupWSConnection(ws, req, { docName, gc: true });
  });

  server.on('upgrade', async (req, socket, head) => {
    let pathname, token, fileId;
    try {
      const u = new URL(req.url, 'http://localhost');
      pathname = u.pathname;
      token = u.searchParams.get('token');
      // /yjs/<fileId>
      const m = pathname.match(/^\/yjs\/([^/]+)$/);
      fileId = m ? decodeURIComponent(m[1]) : null;
    } catch {
      return socket.destroy();
    }
    if (!fileId) return; // not a collab socket — let other upgrade handlers run
    if (!token) return socket.destroy();
    try {
      const payload = jwt.verify(token, env.jwtSecret);
      const user = await prisma.user.findUnique({
        where: { id: payload.sub },
        select: { id: true, name: true, email: true, role: true, banned: true },
      });
      if (!user || user.banned) return socket.destroy();
      const file = await prisma.file.findUnique({ where: { id: fileId } });
      if (!file || file.trashedAt) return socket.destroy();
      // EDIT access required — the CRDT channel is read-write for anyone on it.
      const level = await fileAccessLevel(user, file);
      if (!canEdit(level)) return socket.destroy();
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req, fileId);
      });
    } catch {
      socket.destroy();
    }
  });

  logger.info('WebSocket collab (Yjs) attached at /yjs/:fileId');
}
