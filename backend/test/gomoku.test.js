import { describe, it, expect } from 'vitest';
import { createGame, applyMove, winningLine, BOARD } from '../src/services/games/gomoku.js';

describe('gomoku rules', () => {
  it('rejects out-of-bounds and taken cells', () => {
    const s = createGame();
    expect(applyMove(s, 1, -1, 0).ok).toBe(false);
    expect(applyMove(s, 1, 0, 0).ok).toBe(true);
    expect(applyMove(s, 2, 0, 0).ok).toBe(false); // already taken
  });

  it('detects a horizontal 5-in-a-row', () => {
    const s = createGame();
    let res;
    for (let c = 0; c < 5; c += 1) res = applyMove(s, 1, 7, c);
    expect(res.win).toBe(true);
    expect(res.line).toHaveLength(5);
  });

  it('detects a diagonal win', () => {
    const s = createGame();
    let res;
    for (let i = 0; i < 5; i += 1) res = applyMove(s, 2, i, i);
    expect(res.win).toBe(true);
  });

  it('does not win with four in a row', () => {
    const s = createGame();
    let res;
    for (let c = 0; c < 4; c += 1) res = applyMove(s, 1, 3, c);
    expect(res.win).toBe(false);
  });

  it('winningLine returns null when there is no line', () => {
    const s = createGame();
    applyMove(s, 1, 5, 5);
    expect(winningLine(s.board, 5, 5, 1)).toBeNull();
  });

  it('flags a draw when the last move fills the board without a line', () => {
    const s = createGame();
    // Set every cell except the last directly (we're exercising the draw flag,
    // which keys off move count + whether the *placed* stone completes a line).
    for (let r = 0; r < BOARD; r += 1) {
      for (let c = 0; c < BOARD; c += 1) {
        if (r === BOARD - 1 && c === BOARD - 1) continue;
        s.board[r][c] = ((r + c) % 2) + 1;
        s.moves += 1;
      }
    }
    // Checkerboard parity makes the up-left diagonal through (14,14) all player 1,
    // so finishing with player 2 there can't complete a line.
    const res = applyMove(s, 2, BOARD - 1, BOARD - 1);
    expect(res.win).toBe(false);
    expect(res.draw).toBe(true);
  });
});
