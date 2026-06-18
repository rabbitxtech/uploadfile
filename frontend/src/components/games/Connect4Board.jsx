// Connect Four board. Click anywhere in a column to drop your disc; it falls to
// the lowest empty slot. Player 0 = red, 1 = yellow. The winning four glow.
import { useState } from 'react';

const DISC = ['bg-slate-200 dark:bg-slate-700', 'bg-rose-500', 'bg-amber-400'];

export default function Connect4Board({ room, onPlay }) {
  const [hoverCol, setHoverCol] = useState(null);
  const cols = room.cols || 7;
  const myTurn = room.status === 'playing' && room.turn === room.youIndex;
  const lineSet = new Set((room.line || []).map(([r, c]) => `${r},${c}`));

  return (
    <div className="mx-auto w-full max-w-[560px] rounded-xl bg-blue-700 p-2 shadow-md dark:bg-blue-800">
      <div className="grid gap-1" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
        {room.board.map((row, r) => row.map((v, c) => (
          <button
            key={`${r}-${c}`}
            type="button"
            disabled={!myTurn}
            onMouseEnter={() => setHoverCol(c)}
            onMouseLeave={() => setHoverCol(null)}
            onClick={() => onPlay({ col: c })}
            className={`flex aspect-square items-center justify-center rounded-full transition-colors ${
              myTurn && hoverCol === c ? 'bg-blue-500/60' : 'bg-blue-900/40'
            } ${myTurn ? 'cursor-pointer' : 'cursor-default'}`}
          >
            <span
              className={`h-[82%] w-[82%] rounded-full ${DISC[v]} ${
                lineSet.has(`${r},${c}`) ? 'ring-4 ring-emerald-300' : ''
              } ${v ? 'shadow-inner' : ''}`}
            />
          </button>
        )))}
      </div>
    </div>
  );
}
