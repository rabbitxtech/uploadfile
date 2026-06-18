// Chess renderer + input. The server (services/games/chess.js) is authoritative;
// here chess.js only parses the FEN to draw pieces and to highlight legal targets
// for the selected piece. Pawns auto-promote to a queen for simplicity. The board
// flips so the local player's pieces are always at the bottom.
import { useMemo, useState } from 'react';
import { Chess } from 'chess.js';

const GLYPH = {
  wp: '♙', wn: '♘', wb: '♗', wr: '♖', wq: '♕', wk: '♔',
  bp: '♟', bn: '♞', bb: '♝', br: '♜', bq: '♛', bk: '♚',
};
const FILES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];

export default function ChessBoard({ room, onMove }) {
  const [sel, setSel] = useState(null); // selected square e.g. 'e2'
  const chess = useMemo(() => {
    try {
      return new Chess(room.fen);
    } catch {
      return new Chess();
    }
  }, [room.fen]);

  const myColor = room.youIndex === 0 ? 'w' : 'b';
  const myTurn = room.status === 'playing' && room.turn === room.youIndex;
  const flip = myColor === 'b';

  const targets = useMemo(() => {
    if (!sel) return new Set();
    try {
      return new Set(chess.moves({ square: sel, verbose: true }).map((m) => m.to));
    } catch {
      return new Set();
    }
  }, [sel, chess]);

  // Row/col order depends on perspective.
  const rows = flip ? [...Array(8).keys()] : [...Array(8).keys()].reverse(); // rank index 0..7 (0='1')
  const cols = flip ? [...Array(8).keys()].reverse() : [...Array(8).keys()];

  // King square in check (for the red highlight).
  let checkSquare = null;
  if (room.check) {
    for (let r = 0; r < 8; r += 1) {
      for (let c = 0; c < 8; c += 1) {
        const sq = FILES[c] + (r + 1);
        const p = chess.get(sq);
        if (p && p.type === 'k' && p.color === chess.turn()) checkSquare = sq;
      }
    }
  }

  function clickSquare(sq) {
    if (!myTurn) return;
    const piece = chess.get(sq);
    if (sel && targets.has(sq)) {
      onMove({ from: sel, to: sq, promotion: 'q' });
      setSel(null);
      return;
    }
    if (piece && piece.color === myColor) setSel(sq);
    else setSel(null);
  }

  return (
    <div className="mx-auto w-full max-w-[600px]">
      <div className="grid grid-cols-8 overflow-hidden rounded-lg border-2 border-amber-900/40 shadow-md">
        {rows.map((r) => cols.map((c) => {
          const sq = FILES[c] + (r + 1);
          const piece = chess.get(sq);
          const light = (r + c) % 2 === 1;
          const isSel = sel === sq;
          const isTarget = targets.has(sq);
          const isLast = room.last && (room.last.from === sq || room.last.to === sq);
          const isCheck = checkSquare === sq;
          return (
            <button
              key={sq}
              type="button"
              onClick={() => clickSquare(sq)}
              className={`relative flex aspect-square items-center justify-center text-3xl leading-none transition-colors ${
                light ? 'bg-amber-100' : 'bg-amber-700/80'
              } ${isSel ? '!bg-yellow-300' : ''} ${isLast ? 'ring-2 ring-inset ring-yellow-400/70' : ''} ${
                isCheck ? '!bg-rose-400' : ''
              } ${myTurn ? 'cursor-pointer' : 'cursor-default'}`}
            >
              {piece && (
                <span className={piece.color === 'w' ? 'text-white [text-shadow:0_1px_2px_rgba(0,0,0,0.6)]' : 'text-slate-900'}>
                  {GLYPH[piece.color + piece.type]}
                </span>
              )}
              {isTarget && !piece && <span className="absolute h-3 w-3 rounded-full bg-emerald-600/60" />}
              {isTarget && piece && <span className="absolute inset-0 ring-4 ring-inset ring-emerald-600/60" />}
            </button>
          );
        }))}
      </div>
    </div>
  );
}
