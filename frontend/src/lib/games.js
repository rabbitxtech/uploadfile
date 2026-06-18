// Client for the /gws multiplayer games socket. Page-scoped (unlike the global
// presence socket): the Games page creates one client on mount and closes it on
// unmount. Auto-reconnects while the page is open so a brief drop doesn't kick
// the player out of the lobby; the server is the source of truth for room state.
import { useEffect, useState } from 'react';
import { useAuth } from '../store/auth.js';

function wsUrl() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const token = useAuth.getState().token || '';
  return `${proto}://${location.host}/gws?token=${encodeURIComponent(token)}`;
}

export function createGameClient() {
  let ws = null;
  let queue = [];
  let closed = false;
  const listeners = new Set();
  const statusCbs = new Set();

  const setStatus = (s) => statusCbs.forEach((cb) => cb(s));

  function connect() {
    if (closed) return;
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
    setStatus('connecting');
    try {
      ws = new WebSocket(wsUrl());
    } catch {
      return;
    }
    ws.onopen = () => {
      setStatus('online');
      queue.forEach((m) => ws.send(m));
      queue = [];
    };
    ws.onmessage = (e) => {
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      listeners.forEach((cb) => cb(msg));
    };
    ws.onclose = () => {
      ws = null;
      if (!closed) {
        setStatus('offline');
        setTimeout(connect, 1500);
      }
    };
    ws.onerror = () => {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    };
  }

  connect();

  return {
    send(obj) {
      const m = JSON.stringify(obj);
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(m);
      else queue.push(m);
    },
    on(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    onStatus(cb) {
      statusCbs.add(cb);
      return () => statusCbs.delete(cb);
    },
    close() {
      closed = true;
      try {
        ws?.close();
      } catch {
        /* ignore */
      }
    },
  };
}

// Hook: one game client for the component's lifetime, with connection status.
// The client is created inside the effect (no render-time side effect; the
// socket and its reconnect timer are torn down on unmount / StrictMode remount).
// `client` is null on the first render — callers guard for that.
export function useGameClient() {
  const [client, setClient] = useState(null);
  const [status, setStatus] = useState('connecting');
  useEffect(() => {
    const c = createGameClient();
    const off = c.onStatus(setStatus);
    setClient(c);
    return () => {
      off();
      c.close();
    };
  }, []);
  return { client, status };
}
