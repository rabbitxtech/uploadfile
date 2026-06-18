// Gomoku (Cờ Caro) core rules — pure, side-effect-free so it can be unit-tested
// and reused by the realtime room manager. Board cells hold 0 (empty) or a player
// number (1 or 2). A win is NEED stones in a row horizontally, vertically, or on
// either diagonal. Kept free of any WebSocket/Prisma concern on purpose.
export const BOARD = 15; // 15×15 grid
export const NEED = 5; // 5-in-a-row to win

export function createGame() {
  return {
    board: Array.from({ length: BOARD }, () => Array(BOARD).fill(0)),
    moves: 0,
  };
}

export function inBounds(r, c) {
  return r >= 0 && r < BOARD && c >= 0 && c < BOARD;
}

// Longest contiguous line of `player` stones through (r,c). Returns the full run
// (≥ NEED cells) so the client can highlight it, or null if no win there.
export function winningLine(board, r, c, player) {
  const dirs = [
    [0, 1], // horizontal
    [1, 0], // vertical
    [1, 1], // diagonal down-right
    [1, -1], // diagonal down-left
  ];
  for (const [dr, dc] of dirs) {
    const line = [[r, c]];
    for (let rr = r + dr, cc = c + dc; inBounds(rr, cc) && board[rr][cc] === player; rr += dr, cc += dc) {
      line.push([rr, cc]);
    }
    for (let rr = r - dr, cc = c - dc; inBounds(rr, cc) && board[rr][cc] === player; rr -= dr, cc -= dc) {
      line.unshift([rr, cc]);
    }
    if (line.length >= NEED) return line;
  }
  return null;
}

// Mutates `state`. `player` is 1 or 2. Returns the outcome of the move.
export function applyMove(state, player, r, c) {
  if (!inBounds(r, c)) return { ok: false, error: 'Out of bounds' };
  if (state.board[r][c] !== 0) return { ok: false, error: 'Cell already taken' };
  state.board[r][c] = player;
  state.moves += 1;
  const line = winningLine(state.board, r, c, player);
  const draw = !line && state.moves >= BOARD * BOARD;
  return { ok: true, win: !!line, line, draw };
}

// Uniform engine interface consumed by realtime/games.js (turn-based: tickMs 0).
export const engine = {
  tickMs: 0,
  newState() {
    return { ...createGame(), status: 'waiting', turn: 0, winner: null, line: null };
  },
  ready(state) {
    const fresh = createGame();
    state.board = fresh.board;
    state.moves = 0;
    state.turn = 0;
    state.winner = null;
    state.line = null;
    state.status = 'playing';
  },
  input(state, idx, msg) {
    if (idx !== state.turn) return { error: 'Not your turn' };
    const res = applyMove(state, idx + 1, Number(msg.r), Number(msg.c));
    if (!res.ok) return { error: res.error };
    if (res.win) {
      state.status = 'over';
      state.winner = idx;
      state.line = res.line;
    } else if (res.draw) {
      state.status = 'over';
      state.winner = 'draw';
    } else {
      state.turn = idx === 0 ? 1 : 0;
    }
    return {};
  },
  view(state) {
    return { status: state.status, turn: state.turn, winner: state.winner, line: state.line, board: state.board };
  },
  bot(state, idx) {
    return gomokuBot(state.board, idx + 1);
  },
};

// --- Bot -------------------------------------------------------------------
// Heuristic: score every sensible empty cell by what it does for the bot
// (offense) plus what it would do for the opponent (so blocking a strong threat
// is valued too). No deep search — fast and a fair casual opponent.
function scoreRun(count, openEnds) {
  if (count >= 5) return 1_000_000;
  if (openEnds === 0) return 0; // dead run, can never reach five
  if (count === 4) return openEnds === 2 ? 100_000 : 12_000;
  if (count === 3) return openEnds === 2 ? 5_000 : 600;
  if (count === 2) return openEnds === 2 ? 220 : 60;
  return openEnds === 2 ? 12 : 4; // single stone
}

// Value of placing `player` at (r,c): best run it makes in each of the 4 axes.
function evalCell(board, r, c, player) {
  let total = 0;
  for (const [dr, dc] of [[0, 1], [1, 0], [1, 1], [1, -1]]) {
    let count = 1;
    let open = 0;
    let rr = r + dr;
    let cc = c + dc;
    while (inBounds(rr, cc) && board[rr][cc] === player) { count += 1; rr += dr; cc += dc; }
    if (inBounds(rr, cc) && board[rr][cc] === 0) open += 1;
    rr = r - dr; cc = c - dc;
    while (inBounds(rr, cc) && board[rr][cc] === player) { count += 1; rr -= dr; cc -= dc; }
    if (inBounds(rr, cc) && board[rr][cc] === 0) open += 1;
    total += scoreRun(count, open);
  }
  return total;
}

function gomokuBot(board, me) {
  const opp = me === 1 ? 2 : 1;
  let best = null;
  let bestScore = -1;
  let hasStone = false;
  for (let r = 0; r < BOARD; r += 1) for (let c = 0; c < BOARD; c += 1) if (board[r][c]) hasStone = true;
  if (!hasStone) return { r: Math.floor(BOARD / 2), c: Math.floor(BOARD / 2) };
  for (let r = 0; r < BOARD; r += 1) {
    for (let c = 0; c < BOARD; c += 1) {
      if (board[r][c] !== 0) continue;
      if (!hasNeighbor(board, r, c)) continue; // only consider cells near play
      // Slightly favour offense, but a huge defensive value (blocking an open 4)
      // still dominates, so the bot defends real threats.
      const score = evalCell(board, r, c, me) + evalCell(board, r, c, opp) * 0.9;
      if (score > bestScore) { bestScore = score; best = { r, c }; }
    }
  }
  return best || { r: Math.floor(BOARD / 2), c: Math.floor(BOARD / 2) };
}

function hasNeighbor(board, r, c) {
  for (let dr = -2; dr <= 2; dr += 1) {
    for (let dc = -2; dc <= 2; dc += 1) {
      if (dr === 0 && dc === 0) continue;
      const rr = r + dr;
      const cc = c + dc;
      if (inBounds(rr, cc) && board[rr][cc] !== 0) return true;
    }
  }
  return false;
}
