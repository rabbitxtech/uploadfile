// Memory / Concentration — turn-based. 8 pairs face down. On your turn flip two
// cards; a match scores a point and you go again, a miss passes the turn (the two
// mismatched cards stay face up until the next player's first flip, so both
// players get to see them). Most pairs when the board clears wins. The bot keeps
// a memory of every card it has seen face up and uses it to complete pairs.
const PAIRS = 8;
const COLS = 4;

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export const engine = {
  tickMs: 0,
  newState() {
    return { status: 'waiting', winner: null, turn: 0, scores: [0, 0], cards: [], matched: [], up: [], seen: {} };
  },
  ready(state) {
    const vals = [];
    for (let i = 0; i < PAIRS; i += 1) vals.push(i, i);
    state.cards = shuffle(vals);
    state.matched = Array(state.cards.length).fill(false);
    state.up = [];
    state.seen = {};
    state.turn = 0;
    state.scores = [0, 0];
    state.winner = null;
    state.status = 'playing';
  },
  input(state, idx, msg) {
    if (idx !== state.turn) return { error: 'Not your turn' };
    const c = Number(msg.card);
    if (!Number.isInteger(c) || c < 0 || c >= state.cards.length) return { error: 'Invalid card' };
    // A previous miss is still shown → clear it before the new flip.
    if (state.up.length === 2) state.up = [];
    if (state.matched[c] || state.up.includes(c)) return {};
    state.up.push(c);
    state.seen[c] = state.cards[c];
    if (state.up.length === 2) {
      const [a, b] = state.up;
      if (state.cards[a] === state.cards[b]) {
        state.matched[a] = true;
        state.matched[b] = true;
        state.scores[idx] += 1;
        state.up = [];
        if (state.matched.every(Boolean)) {
          state.status = 'over';
          const [s0, s1] = state.scores;
          state.winner = s0 === s1 ? 'draw' : s0 > s1 ? 0 : 1;
        }
        // match → same player flips again (turn unchanged)
      } else {
        state.turn = idx === 0 ? 1 : 0; // miss → pass (cards stay up until next flip)
      }
    }
    return {};
  },
  view(state) {
    // Only matched or currently-up cards reveal their value; the rest are hidden.
    const faces = state.cards.map((v, i) => (state.matched[i] || state.up.includes(i) ? v : null));
    return { status: state.status, turn: state.turn, winner: state.winner, scores: state.scores, faces, matched: state.matched, up: state.up, cols: COLS };
  },
  bot(state, idx) {
    void idx;
    const byVal = {};
    for (const key of Object.keys(state.seen)) {
      const i = Number(key);
      if (state.matched[i]) continue;
      const v = state.seen[key];
      (byVal[v] = byVal[v] || []).push(i);
    }
    const up = state.up.length === 2 ? [] : state.up; // a shown miss is about to clear
    if (up.length === 1) {
      const v = state.cards[up[0]];
      const known = (byVal[v] || []).filter((i) => i !== up[0] && !state.matched[i]);
      if (known.length) return { card: known[0] }; // complete a known pair
      return { card: pickUnknown(state, up) };
    }
    // Start of a flip pair: open a known pair if we have one, else explore.
    for (const v of Object.keys(byVal)) {
      const cells = byVal[v].filter((i) => !up.includes(i));
      if (cells.length >= 2) return { card: cells[0] };
    }
    return { card: pickUnknown(state, up) };
  },
};

function pickUnknown(state, exclude) {
  const fresh = [];
  const any = [];
  for (let i = 0; i < state.cards.length; i += 1) {
    if (state.matched[i] || exclude.includes(i)) continue;
    any.push(i);
    if (state.seen[i] == null) fresh.push(i);
  }
  const pool = fresh.length ? fresh : any;
  return pool[Math.floor(Math.random() * pool.length)];
}
