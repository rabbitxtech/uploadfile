// Nim "21" — turn-based. 21 sticks on the table; on your turn take 1–3. Whoever
// takes the LAST stick loses. The bot plays perfectly: it always tries to leave
// the opponent a count ≡ 1 (mod 4), the losing residues.
const START = 21;
const MAX_TAKE = 3;

export const engine = {
  tickMs: 0,
  newState() {
    return { status: 'waiting', winner: null, turn: 0, remaining: START };
  },
  ready(state) {
    state.remaining = START;
    state.turn = 0;
    state.winner = null;
    state.status = 'playing';
  },
  input(state, idx, msg) {
    if (idx !== state.turn) return { error: 'Not your turn' };
    const take = Number(msg.take);
    if (!Number.isInteger(take) || take < 1 || take > MAX_TAKE || take > state.remaining) return { error: 'Take 1–3' };
    state.remaining -= take;
    if (state.remaining === 0) {
      state.status = 'over';
      state.winner = idx === 0 ? 1 : 0; // took the last stick → you lose
    } else {
      state.turn = idx === 0 ? 1 : 0;
    }
    return {};
  },
  view(state) {
    return { status: state.status, turn: state.turn, winner: state.winner, remaining: state.remaining, max: MAX_TAKE, start: START };
  },
  bot(state) {
    const r = state.remaining;
    let take = ((r - 1) % 4 + 4) % 4; // leaves r-take ≡ 1 (mod 4)
    if (take < 1 || take > MAX_TAKE) take = 1; // already losing → minimal take
    return { take: Math.min(take, r, MAX_TAKE) };
  },
};
