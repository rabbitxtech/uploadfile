// 2D pixel multiplayer games over WebSocket (/gws?token=<jwt>). A third upgrade
// handler alongside presence (/ws) and collab (/yjs) — like them it returns
// WITHOUT destroying the socket for paths that aren't ours, so the handshakes
// don't clobber each other.
//
// In-memory, single-process, best-effort (same contract as realtime/bus.js): a
// room and the matchmaking queue live only in this process. A second backend
// replica wouldn't share them — fine for a casual games corner, not a system of
// record. Nothing here is persisted.
//
// Game logic is delegated to per-game engines (services/games/*) behind a uniform
// interface, so this file is game-agnostic: it manages rooms, matchmaking, the
// realtime tick loop (engine.tickMs > 0), and the message plumbing.
//
// Protocol (client → server): { type, ... }
//   create   {game}            → make a private room, you are players[0]
//   join     {code}            → join a room by its 4-char code
//   quickmatch {game}          → auto-pair with someone else waiting (else queue)
//   cancel                     → leave the matchmaking queue
//   move     {...}             → a game input (gomoku/chess: {r,c}/{from,to}; pong:
//                                {y|dir}; snake: {dir}) — routed to engine.input
//   rematch                    → reset a finished room for another round
//   chat     {text}            → tiny in-room chat
//   leave                      → leave the current room
// Protocol (server → client): { type, ... }
//   room  (snapshot: code, game, players, youIndex, status, winner, ...engine.view)
//   waiting {game}             → queued for a quick match
//   chat  {from, text}
//   error {message}
import { WebSocketServer } from 'ws';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { prisma } from '../config/prisma.js';
import { logger } from '../config/logger.js';
import { ENGINES, getEngine } from '../services/games/index.js';

const GAMES = new Set(Object.keys(ENGINES));
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous O/0/I/1
const CHAT_MAX = 300;

export function attachGames(server) {
  const wss = new WebSocketServer({ noServer: true });
  const rooms = new Map(); // code -> room
  const queues = new Map(); // game -> [ws] waiting for a quick match

  const newCode = () => {
    let code;
    do {
      code = Array.from({ length: 4 }, () => CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]).join('');
    } while (rooms.has(code));
    return code;
  };

  function send(ws, obj) {
    if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
  }

  function snapshotFor(room, ws) {
    return {
      type: 'room',
      code: room.code,
      game: room.game,
      players: room.players.map((p) => ({ id: p.user.id, name: p.user.name || p.user.email, bot: !!p.bot })),
      youIndex: room.players.findIndex((p) => p.ws === ws),
      vsBot: !!room.vsBot,
      ...room.engine.view(room.state),
    };
  }

  function sendRoom(room) {
    for (const p of room.players) {
      if (p.ws && p.ws.readyState === p.ws.OPEN) p.ws.send(JSON.stringify(snapshotFor(room, p.ws)));
    }
  }

  // Index of the bot seat in a vs-CPU room (a player with no socket), or -1.
  function botIndexOf(room) {
    return room.vsBot ? room.players.findIndex((p) => p.bot) : -1;
  }

  // Turn-based: after a human move, let the bot reply (with a short, natural
  // delay) whenever it's the bot's turn. Re-checks the room each time so a torn-
  // down room or a finished game stops the chain.
  // Whether the bot should act now: turn-based games key off whose turn it is,
  // while simultaneous games (e.g. RPS) expose a botActsNow() hook instead.
  function botActsNow(room, bi) {
    if (room.engine.botActsNow) return room.engine.botActsNow(room.state, bi);
    return room.engine.view(room.state).turn === bi;
  }

  function scheduleBot(room) {
    if (!room.vsBot || room.engine.tickMs) return; // realtime bots run in the loop
    const bi = botIndexOf(room);
    if (bi < 0 || room.state.status !== 'playing') return;
    if (!botActsNow(room, bi)) return;
    setTimeout(() => {
      if (!rooms.has(room.code) || room.state.status !== 'playing') return;
      if (!botActsNow(room, bi)) return;
      const move = room.engine.bot(room.state, bi);
      if (move) room.engine.input(room.state, bi, move);
      sendRoom(room);
      scheduleBot(room);
    }, 550);
  }

  // Realtime games run a tick loop while playing; it stops itself when the game
  // ends or the room empties.
  function stopLoop(room) {
    if (room.loop) {
      clearInterval(room.loop);
      room.loop = null;
    }
  }
  function startLoop(room) {
    if (room.loop || !room.engine.tickMs) return;
    const bi = botIndexOf(room);
    room.loop = setInterval(() => {
      if (bi >= 0 && room.state.status === 'playing') {
        const move = room.engine.bot(room.state, bi);
        if (move) room.engine.input(room.state, bi, move);
      }
      room.engine.tick(room.state);
      sendRoom(room);
      if (room.state.status === 'over') stopLoop(room);
    }, room.engine.tickMs);
  }

  // Begin (or restart) a game once two players are present.
  function beginGame(room) {
    room.engine.ready(room.state);
    sendRoom(room);
    startLoop(room);
    scheduleBot(room); // no-op unless it's a turn-based vs-CPU game on the bot's turn
  }

  function leaveQueue(ws) {
    for (const [game, list] of queues) {
      const i = list.indexOf(ws);
      if (i >= 0) {
        list.splice(i, 1);
        if (list.length === 0) queues.delete(game);
      }
    }
  }

  function leaveRoom(ws) {
    const code = ws.roomCode;
    if (!code) return;
    ws.roomCode = null;
    const room = rooms.get(code);
    if (!room) return;
    room.players = room.players.filter((p) => p.ws !== ws);
    // Empty, or only the CPU seat left → tear the room down.
    if (room.players.length === 0 || room.players.every((p) => !p.ws)) {
      stopLoop(room);
      rooms.delete(code);
      return;
    }
    // Opponent left a live game → the remaining player (now index 0) wins.
    if (room.state.status === 'playing') {
      room.state.status = 'over';
      room.state.winner = 0;
      stopLoop(room);
    }
    for (const p of room.players) send(p.ws, { type: 'opponentLeft' });
    sendRoom(room);
  }

  function createRoom(ws, game) {
    leaveRoom(ws);
    leaveQueue(ws);
    const engine = getEngine(game);
    const code = newCode();
    const room = { code, game, engine, players: [{ ws, user: ws.user }], state: engine.newState(), loop: null };
    rooms.set(code, room);
    ws.roomCode = code;
    sendRoom(room);
  }

  function createBotRoom(ws, game) {
    leaveRoom(ws);
    leaveQueue(ws);
    const engine = getEngine(game);
    const code = newCode();
    const room = {
      code,
      game,
      engine,
      players: [{ ws, user: ws.user }, { bot: true, user: { id: 'cpu', name: 'CPU' } }],
      state: engine.newState(),
      loop: null,
      vsBot: true,
    };
    rooms.set(code, room);
    ws.roomCode = code;
    beginGame(room); // human is player 0 and moves first
  }

  function joinRoom(ws, code) {
    const room = rooms.get((code || '').toUpperCase().trim());
    if (!room) return send(ws, { type: 'error', message: 'Room not found' });
    if (room.players.some((p) => p.ws === ws)) return; // already in it
    if (room.players.length >= 2) return send(ws, { type: 'error', message: 'Room is full' });
    leaveRoom(ws);
    leaveQueue(ws);
    room.players.push({ ws, user: ws.user });
    ws.roomCode = room.code;
    beginGame(room); // second player arrived → start a fresh game
  }

  function quickMatch(ws, game) {
    if (!GAMES.has(game)) return send(ws, { type: 'error', message: 'Unknown game' });
    leaveRoom(ws);
    leaveQueue(ws);
    const list = queues.get(game) || [];
    let opponent = null;
    while (list.length) {
      const cand = list.shift();
      if (cand !== ws && cand.readyState === cand.OPEN) {
        opponent = cand;
        break;
      }
    }
    if (opponent) {
      if (list.length === 0) queues.delete(game);
      const engine = getEngine(game);
      const code = newCode();
      const room = { code, game, engine, players: [{ ws: opponent, user: opponent.user }, { ws, user: ws.user }], state: engine.newState(), loop: null };
      rooms.set(code, room);
      opponent.roomCode = code;
      ws.roomCode = code;
      beginGame(room);
    } else {
      list.push(ws);
      queues.set(game, list);
      send(ws, { type: 'waiting', game });
    }
  }

  function handleMove(ws, msg) {
    const room = rooms.get(ws.roomCode);
    if (!room || room.state.status !== 'playing') return;
    const idx = room.players.findIndex((p) => p.ws === ws);
    if (idx < 0) return;
    const res = room.engine.input(room.state, idx, msg) || {};
    if (res.error) return send(ws, { type: 'error', message: res.error });
    // Turn-based games reflect the move immediately; realtime games let the tick
    // loop broadcast the next frame (the input just changed intent/direction).
    if (!room.engine.tickMs) {
      sendRoom(room);
      scheduleBot(room); // vs-CPU: let the bot reply if it's now its turn
    }
  }

  function rematch(ws) {
    const room = rooms.get(ws.roomCode);
    if (!room || room.state.status !== 'over' || room.players.length < 2) return;
    beginGame(room);
  }

  function chat(ws, text) {
    const room = rooms.get(ws.roomCode);
    if (!room || typeof text !== 'string') return;
    const clean = text.slice(0, CHAT_MAX);
    if (!clean.trim()) return;
    const from = ws.user.name || ws.user.email;
    for (const p of room.players) send(p.ws, { type: 'chat', from, text: clean });
  }

  wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.roomCode = null;
    ws.on('pong', () => (ws.isAlive = true));
    ws.on('message', (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      switch (msg.type) {
        case 'create':
          if (GAMES.has(msg.game)) createRoom(ws, msg.game);
          break;
        case 'createBot':
          if (GAMES.has(msg.game)) createBotRoom(ws, msg.game);
          break;
        case 'join':
          joinRoom(ws, msg.code);
          break;
        case 'quickmatch':
          quickMatch(ws, msg.game);
          break;
        case 'cancel':
          leaveQueue(ws);
          break;
        case 'move':
          handleMove(ws, msg);
          break;
        case 'rematch':
          rematch(ws);
          break;
        case 'chat':
          chat(ws, msg.text);
          break;
        case 'leave':
          leaveQueue(ws);
          leaveRoom(ws);
          break;
        default:
          break;
      }
    });
    ws.on('close', () => {
      leaveQueue(ws);
      leaveRoom(ws);
    });
    ws.on('error', () => {});
  });

  // Heartbeat — drop dead sockets (also cleans their rooms via the close handler).
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
    if (pathname !== '/gws') return; // not a games socket — leave it for the others
    if (!token) return socket.destroy();
    try {
      const payload = jwt.verify(token, env.jwtSecret);
      const user = await prisma.user.findUnique({
        where: { id: payload.sub },
        select: { id: true, name: true, email: true, banned: true },
      });
      if (!user || user.banned) return socket.destroy();
      wss.handleUpgrade(req, socket, head, (ws) => {
        ws.user = user;
        wss.emit('connection', ws, req);
      });
    } catch {
      socket.destroy();
    }
  });

  logger.info('WebSocket games attached at /gws');
}
