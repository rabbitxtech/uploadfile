// Task5 #5 — server-push bus unit tests (no real sockets; ws is duck-typed).
import { describe, it, expect } from 'vitest';
import {
  registerSocket,
  unregisterSocket,
  pushToUser,
  emitFileChange,
  connectedUserCount,
} from '../src/realtime/bus.js';

function fakeWs() {
  const sent = [];
  return {
    OPEN: 1,
    readyState: 1,
    sent,
    send(msg) {
      sent.push(JSON.parse(msg));
    },
  };
}

describe('realtime bus', () => {
  it('delivers to every socket of the user and no one else', () => {
    const a1 = fakeWs();
    const a2 = fakeWs();
    const b = fakeWs();
    registerSocket('user-a', a1);
    registerSocket('user-a', a2);
    registerSocket('user-b', b);

    pushToUser('user-a', { type: 'notification' });
    expect(a1.sent).toEqual([{ type: 'notification' }]);
    expect(a2.sent).toEqual([{ type: 'notification' }]);
    expect(b.sent).toEqual([]);

    unregisterSocket('user-a', a1);
    unregisterSocket('user-a', a2);
    unregisterSocket('user-b', b);
  });

  it('skips sockets that are not open and survives send errors', () => {
    const closed = { OPEN: 1, readyState: 3, send() { throw new Error('closed'); } };
    const broken = { OPEN: 1, readyState: 1, send() { throw new Error('boom'); } };
    registerSocket('user-c', closed);
    registerSocket('user-c', broken);
    expect(() => pushToUser('user-c', { type: 'notification' })).not.toThrow();
    unregisterSocket('user-c', closed);
    unregisterSocket('user-c', broken);
  });

  it('emitFileChange sends a file-change event with the folderId', () => {
    const ws = fakeWs();
    registerSocket('user-d', ws);
    emitFileChange('user-d', 'folder-1');
    emitFileChange('user-d');
    expect(ws.sent).toEqual([
      { type: 'file-change', folderId: 'folder-1' },
      { type: 'file-change', folderId: null },
    ]);
    unregisterSocket('user-d', ws);
  });

  it('cleans up the user entry when the last socket unregisters', () => {
    const before = connectedUserCount();
    const ws = fakeWs();
    registerSocket('user-e', ws);
    expect(connectedUserCount()).toBe(before + 1);
    unregisterSocket('user-e', ws);
    expect(connectedUserCount()).toBe(before);
  });
});
