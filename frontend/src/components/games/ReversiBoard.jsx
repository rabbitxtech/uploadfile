// Reversi / Othello board (8×8). Player 0 = black, 1 = white. Legal moves for your
// turn are dotted; click one to place and flip. A live disc count is shown above.
export default function ReversiBoard({ room, onPlay }) {
  const myTurn = room.status === 'playing' && room.turn === room.youIndex;
  const legal = new Set((room.legal || []).map(([r, c]) => `${r},${c}`));
  const [black, white] = room.scores || [0, 0];

  return (
    <div className="mx-auto w-full max-w-[560px]">
      <div className="mb-2 flex items-center justify-center gap-4 text-sm font-medium">
        <span className="inline-flex items-center gap-1.5"><span className="h-4 w-4 rounded-full bg-slate-900 ring-1 ring-slate-500" /> {black}</span>
        <span className="inline-flex items-center gap-1.5"><span className="h-4 w-4 rounded-full bg-white ring-1 ring-slate-400" /> {white}</span>
      </div>
      <div className="grid grid-cols-8 gap-px overflow-hidden rounded-lg bg-emerald-900 p-1">
        {room.board.map((row, r) => row.map((v, c) => {
          const canPlay = myTurn && legal.has(`${r},${c}`);
          return (
            <button
              key={`${r}-${c}`}
              type="button"
              disabled={!canPlay}
              onClick={() => onPlay({ r, c })}
              className={`flex aspect-square items-center justify-center bg-emerald-700 ${canPlay ? 'cursor-pointer hover:bg-emerald-600' : 'cursor-default'}`}
            >
              {v ? (
                <span className={`h-[78%] w-[78%] rounded-full shadow ${v === 1 ? 'bg-slate-900' : 'bg-white'}`} />
              ) : canPlay ? (
                <span className="h-2.5 w-2.5 rounded-full bg-white/40" />
              ) : null}
            </button>
          );
        }))}
      </div>
    </div>
  );
}
