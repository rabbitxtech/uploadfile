// Memory / Concentration board. Flip two cards on your turn; matches stay up and
// you go again, misses stay shown until your next flip. The server only sends the
// face value of cards that are matched or currently up, so nothing leaks.
const ICONS = ['🍎', '🍌', '🍇', '🍒', '🥝', '🍓', '🍑', '🍍'];

export default function MemoryBoard({ room, onPlay }) {
  const myTurn = room.status === 'playing' && room.turn === room.youIndex;
  const cols = room.cols || 4;
  const up = new Set(room.up || []);

  return (
    <div className="mx-auto w-full max-w-[460px]">
      <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
        {room.faces.map((v, i) => {
          const faceUp = v != null;
          const matched = room.matched?.[i];
          const clickable = myTurn && !matched && !up.has(i);
          return (
            <button
              key={i}
              type="button"
              disabled={!clickable}
              onClick={() => onPlay({ card: i })}
              className={`flex aspect-square items-center justify-center rounded-lg border-2 text-4xl transition-all ${
                faceUp
                  ? matched
                    ? 'border-emerald-400 bg-emerald-50 dark:bg-emerald-500/15'
                    : 'border-indigo-400 bg-white dark:bg-slate-800'
                  : 'border-slate-300 bg-gradient-to-br from-slate-200 to-slate-300 dark:border-slate-600 dark:from-slate-700 dark:to-slate-800'
              } ${clickable ? 'cursor-pointer hover:brightness-105' : 'cursor-default'}`}
            >
              {faceUp ? ICONS[v] : '?'}
            </button>
          );
        })}
      </div>
    </div>
  );
}
