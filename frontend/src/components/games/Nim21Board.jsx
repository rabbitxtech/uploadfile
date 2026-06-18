// Nim "21" board: shows the remaining sticks and Take 1/2/3 buttons. Whoever
// takes the last stick loses.
import { useTranslation } from 'react-i18next';

export default function Nim21Board({ room, onPlay }) {
  const { t } = useTranslation();
  const myTurn = room.status === 'playing' && room.turn === room.youIndex;
  const remaining = room.remaining ?? 0;

  return (
    <div className="mx-auto flex w-full max-w-[520px] flex-col items-center gap-6">
      <div className="flex min-h-[120px] flex-wrap items-end justify-center gap-1.5 rounded-xl border border-slate-200 bg-amber-50 p-5 dark:border-slate-700 dark:bg-slate-800">
        {Array.from({ length: remaining }).map((_, i) => (
          <span key={i} className="h-16 w-3 rounded-sm bg-gradient-to-b from-amber-500 to-amber-700 shadow-sm" />
        ))}
      </div>
      <p className="text-sm text-slate-500 dark:text-slate-400">{t('games.nim.left', { n: remaining })}</p>
      <div className="flex gap-3">
        {[1, 2, 3].map((n) => (
          <button
            key={n}
            type="button"
            disabled={!myTurn || n > remaining}
            onClick={() => onPlay({ take: n })}
            className="btn-primary h-14 w-20 justify-center text-lg disabled:opacity-40"
          >
            {t('games.nim.take', { n })}
          </button>
        ))}
      </div>
    </div>
  );
}
