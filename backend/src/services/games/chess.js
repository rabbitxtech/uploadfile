// Chess — turn-based, full rules delegated to chess.js (legality, check, mate,
// stalemate, draws, castling, en passant, promotion). Player 0 = White, 1 = Black.
// The server holds the authoritative Chess instance; clients get the FEN and the
// last move and render from that (and use their own chess.js for move hints).
import { Chess } from 'chess.js';

function turnIndex(chess) {
  return chess.turn() === 'w' ? 0 : 1;
}

function resolve(state) {
  const chess = state.chess;
  if (!chess.isGameOver()) return;
  state.status = 'over';
  if (chess.isCheckmate()) {
    // The side to move is checkmated → the other side (who just moved) won.
    state.winner = turnIndex(chess) === 0 ? 1 : 0;
  } else {
    state.winner = 'draw'; // stalemate / insufficient material / 50-move / repetition
  }
}

export const engine = {
  tickMs: 0,
  newState() {
    return { status: 'waiting', winner: null, chess: new Chess(), fen: new Chess().fen(), last: null, check: false };
  },
  ready(state) {
    state.chess = new Chess();
    state.fen = state.chess.fen();
    state.last = null;
    state.check = false;
    state.winner = null;
    state.status = 'playing';
  },
  input(state, idx, msg) {
    if (idx !== turnIndex(state.chess)) return { error: 'Not your turn' };
    let move;
    try {
      move = state.chess.move({ from: msg.from, to: msg.to, promotion: msg.promotion || 'q' });
    } catch {
      move = null;
    }
    if (!move) return { error: 'Illegal move' };
    state.fen = state.chess.fen();
    state.last = { from: move.from, to: move.to };
    state.check = state.chess.inCheck();
    resolve(state);
    return {};
  },
  view(state) {
    return {
      status: state.status,
      winner: state.winner,
      turn: turnIndex(state.chess),
      fen: state.fen,
      last: state.last,
      check: state.check,
    };
  },
  bot(state) {
    return chessBot(state.chess);
  },
};

// --- Bot -------------------------------------------------------------------
const VALUE = { p: 1, n: 3, b: 3.2, r: 5, q: 9, k: 0 };

// Material balance from the side-to-move's perspective.
function relEval(chess) {
  let s = 0;
  for (const row of chess.board()) {
    for (const sq of row) {
      if (sq) s += (sq.color === 'w' ? 1 : -1) * VALUE[sq.type];
    }
  }
  return (chess.turn() === 'w' ? 1 : -1) * s;
}

function negamax(chess, depth) {
  if (chess.isGameOver()) {
    if (chess.isCheckmate()) return -100000; // side to move is mated
    return 0; // draw
  }
  if (depth === 0) return relEval(chess);
  let best = -Infinity;
  for (const m of chess.moves()) {
    chess.move(m);
    const score = -negamax(chess, depth - 1);
    chess.undo();
    if (score > best) best = score;
  }
  return best;
}

// 2-ply search (our move + opponent reply), material-only. A light shuffle gives
// move variety among equally-rated options so the bot isn't perfectly repetitive.
function chessBot(chess) {
  const moves = chess.moves({ verbose: true });
  if (!moves.length) return null;
  for (let i = moves.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [moves[i], moves[j]] = [moves[j], moves[i]];
  }
  let best = moves[0];
  let bestScore = -Infinity;
  for (const m of moves) {
    chess.move(m);
    const score = -negamax(chess, 1);
    chess.undo();
    if (score > bestScore) {
      bestScore = score;
      best = m;
    }
  }
  return { from: best.from, to: best.to, promotion: best.promotion || 'q' };
}
