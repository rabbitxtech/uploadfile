// Tic-Tac-Toe board: a 3×3 grid of cells. Player 0 is X, player 1 is O. Click an
// empty cell on your turn. The winning line is highlighted.
const MARK = ['', '✕', '◯'];
const COLOR = ['', 'text-rose-500', 'text-sky-500'];

export default function TicTacToeBoard({ room, onPlay }) {
  const myTurn = room.status === 'playing' && room.turn === room.youIndex;
  const line = room.line || [];
  return (
    <div className="mx-auto grid w-full max-w-[420px] grid-cols-3 gap-2">
      {room.board.map((v, i) => (
        <button
          key={i}
          type="button"
          disabled={!myTurn || v !== 0}
          onClick={() => onPlay({ cell: i })}
          className={`flex aspect-square items-center justify-center rounded-lg border-2 text-5xl font-bold transition-colors ${
            line.includes(i)
              ? 'border-emerald-400 bg-emerald-100 dark:bg-emerald-500/20'
              : 'border-slate-200 bg-white hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:hover:bg-slate-700'
          } ${COLOR[v]} disabled:cursor-default`}
        >
          {MARK[v]}
        </button>
      ))}
    </div>
  );
}
