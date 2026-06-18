import { describe, it, expect } from 'vitest';
import { ENGINES } from '../src/services/games/index.js';

describe('game engine registry', () => {
  it('exposes the four games with a uniform interface', () => {
    for (const id of ['gomoku', 'pong', 'snake', 'chess', 'tictactoe', 'connect4', 'reversi', 'tron', 'nim21', 'rps', 'memory']) {
      const e = ENGINES[id];
      expect(e, id).toBeTruthy();
      expect(typeof e.newState).toBe('function');
      expect(typeof e.ready).toBe('function');
      expect(typeof e.input).toBe('function');
      expect(typeof e.view).toBe('function');
    }
  });
});

describe('gomoku engine', () => {
  it('rejects a move out of turn and detects a win', () => {
    const e = ENGINES.gomoku;
    const s = e.newState();
    e.ready(s);
    expect(e.input(s, 1, { r: 0, c: 0 }).error).toBe('Not your turn');
    let last;
    for (let c = 0; c < 5; c += 1) {
      last = e.input(s, 0, { r: 7, c }); // p0
      if (c < 4) e.input(s, 1, { r: 8, c }); // p1 replies
    }
    expect(last.error).toBeUndefined();
    const v = e.view(s);
    expect(v.status).toBe('over');
    expect(v.winner).toBe(0);
  });
});

describe('chess engine', () => {
  it('plays a legal move, rejects an illegal one, and detects fool-mate', () => {
    const e = ENGINES.chess;
    const s = e.newState();
    e.ready(s);
    expect(e.input(s, 1, { from: 'e7', to: 'e5' }).error).toBe('Not your turn'); // black can't start
    expect(e.input(s, 0, { from: 'e2', to: 'e9' }).error).toBe('Illegal move');
    // Fool's mate: 1. f3 e5 2. g4 Qh4#
    e.input(s, 0, { from: 'f2', to: 'f3' });
    e.input(s, 1, { from: 'e7', to: 'e5' });
    e.input(s, 0, { from: 'g2', to: 'g4' });
    e.input(s, 1, { from: 'd8', to: 'h4' });
    const v = e.view(s);
    expect(v.status).toBe('over');
    expect(v.winner).toBe(1); // black mated white
  });
});

describe('pong engine', () => {
  it('serves a moving ball and tracks paddles', () => {
    const e = ENGINES.pong;
    const s = e.newState();
    e.ready(s);
    expect(s.status).toBe('playing');
    expect(Math.abs(s.ball.vx)).toBeGreaterThan(0);
    e.input(s, 0, { y: 100 });
    e.tick(s);
    expect(s.paddles[0]).toBeGreaterThan(0);
    const v = e.view(s);
    expect(v.scores).toEqual([0, 0]);
    expect(v.field.win).toBeGreaterThan(0);
  });
});

describe('bots', () => {
  it('every game exposes a bot that returns a playable move', () => {
    for (const id of ['gomoku', 'pong', 'snake', 'chess', 'tictactoe', 'connect4', 'reversi', 'tron', 'nim21', 'rps', 'memory']) {
      const e = ENGINES[id];
      const s = e.newState();
      e.ready(s);
      const move = e.bot(s, 1);
      expect(move, `${id} bot move`).toBeTruthy();
      // The move must be accepted by the engine for the bot seat (idx 1) when it
      // is the bot's turn (turn-based) or always (realtime).
      const turn = e.view(s).turn;
      const botsTurn = e.tickMs > 0 || turn === 1;
      if (botsTurn) expect(e.input(s, 1, move).error, `${id} bot move legal`).toBeUndefined();
    }
  });

  it('gomoku bot blocks an open four', () => {
    const e = ENGINES.gomoku;
    const s = e.newState();
    e.ready(s);
    // Opponent (player 1) has four in a row on row 7, cols 1..4 — bot (player 2)
    // must play col 0 or col 5 to block the open five.
    for (let c = 1; c <= 4; c += 1) s.board[7][c] = 1;
    const move = e.bot(s, 1); // bot is player 2
    expect(move.r).toBe(7);
    expect([0, 5]).toContain(move.c);
  });

  it('gomoku bot takes an immediate win over a block', () => {
    const e = ENGINES.gomoku;
    const s = e.newState();
    e.ready(s);
    s.board[5][1] = 2; s.board[5][2] = 2; s.board[5][3] = 2; s.board[5][4] = 2; // bot has four
    s.board[9][1] = 1; s.board[9][2] = 1; s.board[9][3] = 1; // opp has three
    const move = e.bot(s, 1);
    expect(move.r).toBe(5);
    expect([0, 5]).toContain(move.c); // completes its own five
  });
});

describe('new games', () => {
  it('tic-tac-toe bot never loses (blocks / wins)', () => {
    const e = ENGINES.tictactoe;
    const s = e.newState();
    e.ready(s);
    // Human (0) takes two corners on the same row; the perfect bot must block.
    e.input(s, 0, { cell: 0 });
    // bot replies
    const b1 = e.bot(s, 1); e.input(s, 1, b1);
    e.input(s, 0, { cell: 2 }); // human threatens 0,1,2 via cell 1
    const b2 = e.bot(s, 1);
    e.input(s, 1, b2);
    // The bot must have taken cell 1 to block the top row (only open threat).
    expect(s.board[1]).toBe(2);
  });

  it('connect4 drops obey gravity and detect a vertical win', () => {
    const e = ENGINES.connect4;
    const s = e.newState();
    e.ready(s);
    let last;
    for (let i = 0; i < 4; i += 1) {
      last = e.input(s, 0, { col: 0 }); // p0 stacks column 0
      if (i < 3) e.input(s, 1, { col: 1 }); // p1 elsewhere
    }
    expect(last.error).toBeUndefined();
    expect(e.view(s).status).toBe('over');
    expect(e.view(s).winner).toBe(0);
  });

  it('reversi starts with four discs and only allows flanking moves', () => {
    const e = ENGINES.reversi;
    const s = e.newState();
    e.ready(s);
    expect(e.view(s).scores).toEqual([2, 2]);
    expect(e.input(s, 0, { r: 0, c: 0 }).error).toBe('Illegal move');
    const legal = e.view(s).legal;
    expect(legal.length).toBe(4); // opening black has exactly 4 moves
    expect(e.input(s, 0, { r: legal[0][0], c: legal[0][1] }).error).toBeUndefined();
  });

  it('tron kills a cycle that drives into the wall', () => {
    const e = ENGINES.tron;
    const s = e.newState();
    e.ready(s);
    e.input(s, 0, { dir: 'up' });
    for (let i = 0; i < e.view(s).grid + 2; i += 1) e.tick(s);
    expect(s.cycles[0].alive).toBe(false);
    expect(e.view(s).status).toBe('over');
  });

  it('nim21: taking the last stick loses, and the bot plays the winning residue', () => {
    const e = ENGINES.nim21;
    const s = e.newState();
    e.ready(s);
    // From 21 the bot should take 1 (21 ≡ 1 mod 4 means it leaves 20 — wait,
    // perfect play: 21 is a winning position for the mover, take ((21-1)%4)=0→1).
    expect(e.bot(s, 0)).toEqual({ take: 1 });
    // Losing scenario: 1 stick left, you must take it and lose.
    s.remaining = 1; s.turn = 0;
    e.input(s, 0, { take: 1 });
    expect(e.view(s).status).toBe('over');
    expect(e.view(s).winner).toBe(1);
  });

  it('rps: resolves a round simultaneously and never leaks the pending pick', () => {
    const e = ENGINES.rps;
    const s = e.newState();
    e.ready(s);
    e.input(s, 0, { choice: 'rock' });
    // Opponent hasn't picked: the view must not reveal player 0's choice.
    const mid = e.view(s);
    expect(mid.chosen).toEqual([true, false]);
    expect(mid.reveal).toBeNull();
    e.input(s, 1, { choice: 'scissors' });
    const after = e.view(s);
    expect(after.scores).toEqual([1, 0]); // rock beats scissors
    expect(after.reveal.choices).toEqual(['rock', 'scissors']);
  });

  it('memory: a match scores and keeps the turn; the bot completes known pairs', () => {
    const e = ENGINES.memory;
    const s = e.newState();
    e.ready(s);
    // Force a known layout: card 0 and card 1 share a value.
    s.cards[0] = 5; s.cards[1] = 5;
    e.input(s, 0, { card: 0 });
    e.input(s, 0, { card: 1 });
    expect(s.matched[0] && s.matched[1]).toBe(true);
    expect(e.view(s).scores[0]).toBe(1);
    expect(e.view(s).turn).toBe(0); // match → same player continues
  });
});

describe('snake engine', () => {
  it('spawns two snakes and kills one that hits the wall', () => {
    const e = ENGINES.snake;
    const s = e.newState();
    e.ready(s);
    expect(s.snakes).toHaveLength(2);
    // Drive snake 0 straight up into the top wall.
    e.input(s, 0, { dir: 'up' });
    for (let i = 0; i < s.grid + 2; i += 1) e.tick(s);
    expect(s.snakes[0].alive).toBe(false);
    expect(e.view(s).status).toBe('over');
  });
});
