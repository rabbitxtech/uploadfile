// Tic-Tac-Toe — turn-based 3×3. Board is a flat array of 9 (0 empty, 1 / 2). The
// bot is a perfect minimax player, so the best a human can get is a draw.
const LINES = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8], // rows
  [0, 3, 6], [1, 4, 7], [2, 5, 8], // cols
  [0, 4, 8], [2, 4, 6], // diagonals
];

function winnerLine(board, p) {
  return LINES.find((l) => l.every((i) => board[i] === p)) || null;
}

export const engine = {
  tickMs: 0,
  newState() {
    return { status: 'waiting', winner: null, turn: 0, line: null, board: Array(9).fill(0) };
  },
  ready(state) {
    state.board = Array(9).fill(0);
    state.turn = 0;
    state.winner = null;
    state.line = null;
    state.status = 'playing';
  },
  input(state, idx, msg) {
    if (idx !== state.turn) return { error: 'Not your turn' };
    const cell = Number(msg.cell);
    if (!Number.isInteger(cell) || cell < 0 || cell > 8 || state.board[cell] !== 0) return { error: 'Invalid cell' };
    state.board[cell] = idx + 1;
    const line = winnerLine(state.board, idx + 1);
    if (line) {
      state.status = 'over';
      state.winner = idx;
      state.line = line;
    } else if (state.board.every((v) => v !== 0)) {
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
    const me = idx + 1;
    const opp = me === 1 ? 2 : 1;
    const best = minimax(state.board.slice(), me, me, opp);
    return { cell: best.cell };
  },
};

// Returns { score, cell } for the side `player` to move. score is from `me`'s view.
function minimax(board, player, me, opp) {
  const winM = winnerLine(board, me);
  const winO = winnerLine(board, opp);
  if (winM) return { score: 10, cell: -1 };
  if (winO) return { score: -10, cell: -1 };
  const empty = board.map((v, i) => (v === 0 ? i : -1)).filter((i) => i >= 0);
  if (empty.length === 0) return { score: 0, cell: -1 };
  let best = { score: player === me ? -Infinity : Infinity, cell: empty[0] };
  for (const cell of empty) {
    board[cell] = player;
    const { score } = minimax(board, player === me ? opp : me, me, opp);
    board[cell] = 0;
    if (player === me ? score > best.score : score < best.score) best = { score, cell };
  }
  return best;
}
