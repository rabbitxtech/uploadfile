// Reversi / Othello — turn-based 8×8. Player 0 = black (moves first), 1 = white.
// A move must flank at least one opponent disc; flanked discs flip. If a player
// has no legal move their turn is auto-passed; if neither can move the game ends
// and the majority of discs wins. The bot plays a positional heuristic (corners
// are gold, squares next to them are poison).
const N = 8;
const DIRS = [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]];

// Classic positional weights (corners high, X/C squares negative).
const WEIGHTS = [
  [120, -20, 20, 5, 5, 20, -20, 120],
  [-20, -40, -5, -5, -5, -5, -40, -20],
  [20, -5, 15, 3, 3, 15, -5, 20],
  [5, -5, 3, 3, 3, 3, -5, 5],
  [5, -5, 3, 3, 3, 3, -5, 5],
  [20, -5, 15, 3, 3, 15, -5, 20],
  [-20, -40, -5, -5, -5, -5, -40, -20],
  [120, -20, 20, 5, 5, 20, -20, 120],
];

function startBoard() {
  const b = Array.from({ length: N }, () => Array(N).fill(0));
  b[3][3] = 2; b[3][4] = 1; b[4][3] = 1; b[4][4] = 2;
  return b;
}

const inB = (r, c) => r >= 0 && r < N && c >= 0 && c < N;

// Discs that would flip if `p` plays (r,c); empty array if it's not a legal move.
function flips(board, r, c, p) {
  if (board[r][c] !== 0) return [];
  const opp = p === 1 ? 2 : 1;
  const out = [];
  for (const [dr, dc] of DIRS) {
    const run = [];
    let rr = r + dr;
    let cc = c + dc;
    while (inB(rr, cc) && board[rr][cc] === opp) { run.push([rr, cc]); rr += dr; cc += dc; }
    if (run.length && inB(rr, cc) && board[rr][cc] === p) out.push(...run);
  }
  return out;
}

function legalMoves(board, p) {
  const moves = [];
  for (let r = 0; r < N; r += 1) for (let c = 0; c < N; c += 1) if (flips(board, r, c, p).length) moves.push([r, c]);
  return moves;
}

function counts(board) {
  let a = 0;
  let b = 0;
  for (const row of board) for (const v of row) { if (v === 1) a += 1; else if (v === 2) b += 1; }
  return [a, b];
}

// Set state.turn to the next side that has a move; end the game if neither does.
function advance(state) {
  const next = state.turn === 0 ? 1 : 0;
  if (legalMoves(state.board, next + 1).length) { state.turn = next; return; }
  if (legalMoves(state.board, state.turn + 1).length) return; // opponent passes
  state.status = 'over';
  const [black, white] = counts(state.board);
  state.winner = black === white ? 'draw' : black > white ? 0 : 1;
}

export const engine = {
  tickMs: 0,
  newState() {
    return { status: 'waiting', winner: null, turn: 0, board: startBoard() };
  },
  ready(state) {
    state.board = startBoard();
    state.turn = 0;
    state.winner = null;
    state.status = 'playing';
  },
  input(state, idx, msg) {
    if (idx !== state.turn) return { error: 'Not your turn' };
    const r = Number(msg.r);
    const c = Number(msg.c);
    if (!Number.isInteger(r) || !Number.isInteger(c) || !inB(r, c)) return { error: 'Invalid cell' };
    const flipped = flips(state.board, r, c, idx + 1);
    if (!flipped.length) return { error: 'Illegal move' };
    state.board[r][c] = idx + 1;
    for (const [fr, fc] of flipped) state.board[fr][fc] = idx + 1;
    advance(state);
    return {};
  },
  view(state) {
    return {
      status: state.status,
      turn: state.turn,
      winner: state.winner,
      board: state.board,
      scores: counts(state.board),
      legal: state.status === 'playing' ? legalMoves(state.board, state.turn + 1) : [],
    };
  },
  bot(state, idx) {
    const me = idx + 1;
    const moves = legalMoves(state.board, me);
    if (!moves.length) return null;
    let best = moves[0];
    let bestScore = -Infinity;
    for (const [r, c] of moves) {
      // Positional value of the square + a small bonus per disc flipped.
      const score = WEIGHTS[r][c] + flips(state.board, r, c, me).length;
      if (score > bestScore) { bestScore = score; best = [r, c]; }
    }
    return { r: best[0], c: best[1] };
  },
};
