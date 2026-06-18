// Rock-Paper-Scissors — SIMULTANEOUS (not alternating turns), best of 5. Both
// players commit a choice each round; when both are in, the round resolves and
// `reveal` holds the result until the next round resolves (the client tracks its
// own "I've picked, waiting" state). No turn field is exposed, so the room driver
// uses the engine's botActsNow() hook to know when the CPU should commit.
const CHOICES = ['rock', 'paper', 'scissors'];
const BEATS = { rock: 'scissors', paper: 'rock', scissors: 'paper' };
const WIN_ROUNDS = 3; // best of 5

export const engine = {
  tickMs: 0,
  newState() {
    return { status: 'waiting', winner: null, scores: [0, 0], round: 1, choices: [null, null], reveal: null };
  },
  ready(state) {
    state.scores = [0, 0];
    state.round = 1;
    state.choices = [null, null];
    state.reveal = null;
    state.winner = null;
    state.status = 'playing';
  },
  input(state, idx, msg) {
    if (state.status !== 'playing') return {};
    if (state.choices[idx] != null) return {}; // already committed this round
    if (!CHOICES.includes(msg.choice)) return { error: 'Invalid choice' };
    state.choices[idx] = msg.choice;
    if (state.choices[0] && state.choices[1]) {
      const [a, b] = state.choices;
      let result; // 0 = player 0 wins the round, 1 = player 1, -1 = tie
      if (a === b) result = -1;
      else result = BEATS[a] === b ? 0 : 1;
      if (result === 0) state.scores[0] += 1;
      else if (result === 1) state.scores[1] += 1;
      state.reveal = { choices: [a, b], result };
      state.choices = [null, null];
      if (state.scores[0] >= WIN_ROUNDS || state.scores[1] >= WIN_ROUNDS) {
        state.status = 'over';
        state.winner = state.scores[0] > state.scores[1] ? 0 : 1;
      } else {
        state.round += 1;
      }
    }
    return {};
  },
  view(state) {
    return {
      status: state.status,
      winner: state.winner,
      scores: state.scores,
      round: state.round,
      chosen: [state.choices[0] != null, state.choices[1] != null], // commit flags, not the actual picks
      reveal: state.reveal,
      winRounds: WIN_ROUNDS,
    };
  },
  // Simultaneous game: the CPU should commit whenever it hasn't yet this round.
  botActsNow(state, idx) {
    return state.status === 'playing' && state.choices[idx] == null;
  },
  bot() {
    return { choice: CHOICES[Math.floor(Math.random() * 3)] };
  },
};
