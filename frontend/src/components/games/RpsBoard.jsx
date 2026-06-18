// Rock-Paper-Scissors board (best of 5). Simultaneous: you commit a choice, then
// wait for the opponent. The server reveals both picks once they're in; we track
// our own pick locally and reset it when a new round starts.
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

const ICON = { rock: '✊', paper: '✋', scissors: '✌️' };
const OPTIONS = ['rock', 'paper', 'scissors'];

export default function RpsBoard({ room, onPlay }) {
  const { t } = useTranslation();
  const me = room.youIndex;
  const opp = me === 0 ? 1 : 0;
  const [pick, setPick] = useState(null);

  // New round (round number changed) → clear our local pick.
  useEffect(() => setPick(null), [room.round]);

  const playing = room.status === 'playing';
  const committed = pick != null || room.chosen?.[me];
  const reveal = room.reveal;
  const [s0, s1] = room.scores || [0, 0];

  let resultText = '';
  if (reveal) {
    if (reveal.result === -1) resultText = t('games.rps.tie');
    else resultText = reveal.result === me ? t('games.rps.wonRound') : t('games.rps.lostRound');
  }

  return (
    <div className="mx-auto flex w-full max-w-[520px] flex-col items-center gap-5">
      <div className="flex items-center gap-6 text-2xl font-bold">
        <span className="tabular-nums">{me === 0 ? s0 : s1}</span>
        <span className="text-sm font-normal text-slate-400">{t('games.rps.bestOf', { n: (room.winRounds || 3) * 2 - 1 })}</span>
        <span className="tabular-nums">{me === 0 ? s1 : s0}</span>
      </div>

      {/* Reveal / status panel */}
      <div className="flex min-h-[88px] w-full items-center justify-center gap-6 rounded-xl border border-slate-200 bg-white text-5xl dark:border-slate-700 dark:bg-slate-800">
        {reveal ? (
          <>
            <span title={t('games.rps.you')}>{ICON[reveal.choices[me]]}</span>
            <span className="text-base font-medium text-slate-500">{resultText}</span>
            <span title={t('games.rps.opponent')}>{ICON[reveal.choices[opp]]}</span>
          </>
        ) : committed ? (
          <span className="text-base text-slate-500">{room.chosen?.[opp] ? t('games.rps.revealing') : t('games.rps.waitingOpp')}</span>
        ) : (
          <span className="text-base text-slate-400">{t('games.rps.pick')}</span>
        )}
      </div>

      <div className="flex gap-3">
        {OPTIONS.map((c) => (
          <button
            key={c}
            type="button"
            disabled={!playing || committed}
            onClick={() => { setPick(c); onPlay({ choice: c }); }}
            className={`flex h-20 w-20 items-center justify-center rounded-xl border-2 text-4xl transition-colors ${
              pick === c ? 'border-indigo-500 bg-indigo-50 dark:bg-indigo-500/15' : 'border-slate-200 bg-white hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:hover:bg-slate-700'
            } disabled:opacity-50`}
            aria-label={c}
          >
            {ICON[c]}
          </button>
        ))}
      </div>
    </div>
  );
}
