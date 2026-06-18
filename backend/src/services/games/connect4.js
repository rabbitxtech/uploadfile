// Connect Four — turn-based, 7 columns × 6 rows. Drop a disc into a column; it
// falls to the lowest empty cell. Four in a row (any direction) wins. The bot
// takes an immediate win, blocks an immediate loss, else prefers central columns.
export const COLS = 7;
export const ROWS = 6;

function emptyBoard() {
  return Array.from({ length: ROWS }, () => Array(COLS).fill(0));
}

// Lowest empty row in a column, or -1 if full.
function dropRow(board, col) {
  for (let r = ROWS - 1; r >= 0; r -= 1) if (board[r][col] === 0) return r;
  return -1;
}

function lineThrough(board, r, c, p) {
  for (const [dr, dc] of [[0, 1], [1, 0], [1, 1], [1, -1]]) {
    const cells = [[r, c]];
    for (let rr = r + dr, cc = c + dc; rr >= 0 && rr < ROWS && cc >= 0 && cc < COLS && board[rr][cc] === p; rr += dr, cc += dc) cells.push([rr, cc]);
    for (let rr = r - dr, cc = c - dc; rr >= 0 && rr < ROWS && cc >= 0 && cc < COLS && board[rr][cc] === p; rr -= dr, cc -= dc) cells.unshift([rr, cc]);
    if (cells.length >= 4) return cells;
  }
  return null;
}

function applyDrop(board, col, p) {
  const r = dropRow(board, col);
  if (r < 0) return null;
  board[r][col] = p;
  return { r, line: lineThrough(board, r, col, p) };
}

export const engine = {
  tickMs: 0,
  newState() {
    return { status: 'waiting', winner: null, turn: 0, line: null, board: emptyBoard() };
  },
  ready(state) {
    state.board = emptyBoard();
    state.turn = 0;
    state.winner = null;
    state.line = null;
    state.status = 'playing';
  },
  input(state, idx, msg) {
    if (idx !== state.turn) return { error: 'Not your turn' };
    const col = Number(msg.col);
    if (!Number.isInteger(col) || col < 0 || col >= COLS) return { error: 'Invalid column' };
    const res = applyDrop(state.board, col, idx + 1);
    if (!res) return { error: 'Column is full' };
    if (res.line) {
      state.status = 'over';
      state.winner = idx;
      state.line = res.line;
    } else if (state.board[0].every((v) => v !== 0)) {
      state.status = 'over';
      state.winner = 'draw';
    } else {
      state.turn = idx === 0 ? 1 : 0;
    }
    return {};
  },
  view(state) {
    return { status: state.status, turn: state.turn, winner: state.winner, line: state.line, board: state.board, cols: COLS, rows: ROWS };
  },
  bot(state, idx) {
    const me = idx + 1;
    const opp = me === 1 ? 2 : 1;
    const playable = [];
    for (let c = 0; c < COLS; c += 1) if (dropRow(state.board, c) >= 0) playable.push(c);
    // 1) take a winning drop; 2) block the opponent's winning drop.
    for (const p of [me, opp]) {
      for (const c of playable) {
        const copy = state.board.map((row) => row.slice());
        const res = applyDrop(copy, c, p);
        if (res?.line) return { col: c };
      }
    }
    // 3) prefer the centre (don't hand the opponent a winning reply if avoidable).
    const order = [3, 2, 4, 1, 5, 0, 6].filter((c) => playable.includes(c));
    for (const c of order) {
      const copy = state.board.map((row) => row.slice());
      applyDrop(copy, c, me);
      let givesWin = false;
      for (const oc of playable) {
        const copy2 = copy.map((row) => row.slice());
        const r = dropRow(copy2, oc);
        if (r >= 0) {
          copy2[r][oc] = opp;
          if (lineThrough(copy2, r, oc, opp)) givesWin = true;
        }
      }
      if (!givesWin) return { col: c };
    }
    return { col: order[0] ?? playable[0] };
  },
};
