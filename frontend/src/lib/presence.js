// I4 — client-side presence over a single shared WebSocket. Components subscribe
// to a fileId via usePresence(); the manager ref-counts rooms, (re)connects, and
// re-joins active rooms after reconnects.
// Task5 #5 — the same socket also carries server-push events ('notification',
// 'file-change'); subscribe via subscribeServerEvents().
import { useEffect, useState } from 'react';
import { useAuth } from '../store/auth.js';

let ws = null;
let queue = [];
const subs = new Map(); // fileId -> Set<callback>
const refs = new Map(); // fileId -> count
const eventSubs = new Set(); // callbacks for server-push events

function wsUrl() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const token = useAuth.getState().token || '';
  return `${proto}://${location.host}/ws?token=${encodeURIComponent(token)}`;
}

function send(obj) {
  const m = JSON.stringify(obj);
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(m);
  else queue.push(m);
}

function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  try {
    ws = new WebSocket(wsUrl());
  } catch {
    return;
  }
  ws.onopen = () => {
    queue.forEach((m) => ws.send(m));
    queue = [];
    for (const fileId of refs.keys()) ws.send(JSON.stringify({ type: 'join', fileId }));
  };
  ws.onmessage = (e) => {
    let msg;
    try {
      msg = JSON.parse(e.data);
    } catch {
      return;
    }
    if (msg.type === 'presence') {
      const set = subs.get(msg.fileId);
      if (set) set.forEach((cb) => cb(msg.viewers || []));
    } else {
      // Server-push event (notification / file-change) — fan out to listeners.
      eventSubs.forEach((cb) => cb(msg));
    }
  };
  ws.onclose = () => {
    ws = null;
    if (refs.size || eventSubs.size) setTimeout(connect, 2000);
  };
  ws.onerror = () => {
    try {
      ws.close();
    } catch {
      /* ignore */
    }
  };
}

export function joinPresence(fileId, cb) {
  if (!subs.has(fileId)) subs.set(fileId, new Set());
  subs.get(fileId).add(cb);
  const next = (refs.get(fileId) || 0) + 1;
  refs.set(fileId, next);
  connect();
  if (next === 1) send({ type: 'join', fileId });
  return () => {
    const set = subs.get(fileId);
    if (set) set.delete(cb);
    const n = (refs.get(fileId) || 1) - 1;
    if (n <= 0) {
      refs.delete(fileId);
      subs.delete(fileId);
      send({ type: 'leave', fileId });
    } else {
      refs.set(fileId, n);
    }
  };
}

// Task5 #5 — listen for server-push events ({type:'notification'|'file-change'}).
// Keeps the shared socket alive while at least one listener is registered.
export function subscribeServerEvents(cb) {
  eventSubs.add(cb);
  connect();
  return () => {
    eventSubs.delete(cb);
  };
}

export function usePresence(fileId) {
  const [viewers, setViewers] = useState([]);
  useEffect(() => {
    if (!fileId) return undefined;
    setViewers([]);
    const off = joinPresence(fileId, setViewers);
    return () => {
      off();
      setViewers([]);
    };
  }, [fileId]);
  return viewers;
}
