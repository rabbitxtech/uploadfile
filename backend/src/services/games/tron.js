// Tron light cycles — realtime on a GRID×GRID board. Each cycle leaves a solid
// trail behind it and dies on hitting a wall, any trail (its own or the rival's),
// or a head-on. Last cycle riding wins; simultaneous crash is a draw. Like Snake
// but trails never shrink and there's no food.
export const GRID = 28;

const DIRS = { up: { x: 0, y: -1 }, down: { x: 0, y: 1 }, left: { x: -1, y: 0 }, right: { x: 1, y: 0 } };
const OPPOSITE = { up: 'down', down: 'up', left: 'right', right: 'left' };

function makeCycle(x, y, dir) {
  return { trail: [{ x, y }], dir, nextDir: dir, alive: true };
}

export const engine = {
  tickMs: 75, // fast
  newState() {
    return { status: 'waiting', winner: null, grid: GRID, cycles: [] };
  },
  ready(state) {
    const mid = Math.floor(GRID / 2);
    state.cycles = [makeCycle(3, mid, 'right'), makeCycle(GRID - 4, mid, 'left')];
    state.winner = null;
    state.status = 'playing';
  },
  input(state, idx, msg) {
    const c = state.cycles[idx];
    if (!c || !c.alive) return {};
    if (DIRS[msg.dir] && msg.dir !== OPPOSITE[c.dir]) c.nextDir = msg.dir;
    return {};
  },
  tick(state) {
    if (state.status !== 'playing') return;
    const occupied = new Set();
    for (const c of state.cycles) for (const cell of c.trail) occupied.add(`${cell.x},${cell.y}`);
    const heads = state.cycles.map((c) => {
      if (!c.alive) return null;
      c.dir = c.nextDir;
      const d = DIRS[c.dir];
      return { x: c.trail[0].x + d.x, y: c.trail[0].y + d.y };
    });
    const dead = [false, false];
    heads.forEach((h, i) => {
      if (!h) return;
      if (h.x < 0 || h.x >= GRID || h.y < 0 || h.y >= GRID || occupied.has(`${h.x},${h.y}`)) dead[i] = true;
    });
    if (heads[0] && heads[1] && heads[0].x === heads[1].x && heads[0].y === heads[1].y) { dead[0] = true; dead[1] = true; }
    state.cycles.forEach((c, i) => {
      if (!c.alive) return;
      if (dead[i]) { c.alive = false; return; }
      c.trail.unshift(heads[i]); // trail grows forever (never pop)
    });
    const alive = state.cycles.map((c) => c.alive);
    if (!alive[0] && !alive[1]) { state.status = 'over'; state.winner = 'draw'; } else if (!alive[0] || !alive[1]) {
      state.status = 'over';
      state.winner = alive[0] ? 0 : 1;
    }
  },
  view(state) {
    return {
      status: state.status,
      winner: state.winner,
      grid: state.grid,
      cycles: state.cycles.map((c) => ({ trail: c.trail, alive: c.alive })),
    };
  },
  // Bot: never reverse, avoid an immediate crash, and prefer the direction with
  // the most open space ahead (a few cells of look-ahead) so it doesn't trap itself.
  bot(state, idx) {
    const me = state.cycles[idx];
    if (!me || !me.alive) return null;
    const head = me.trail[0];
    const occupied = new Set();
    for (const c of state.cycles) for (const cell of c.trail) occupied.add(`${cell.x},${cell.y}`);
    const safeFor = (x, y) => x >= 0 && x < GRID && y >= 0 && y < GRID && !occupied.has(`${x},${y}`);
    const options = ['up', 'down', 'left', 'right'].filter((d) => d !== OPPOSITE[me.dir]);
    let best = me.dir;
    let bestSpace = -1;
    for (const d of options) {
      const v = DIRS[d];
      let x = head.x + v.x;
      let y = head.y + v.y;
      if (!safeFor(x, y)) continue;
      let space = 0;
      while (safeFor(x, y) && space < GRID) { space += 1; x += v.x; y += v.y; }
      if (space > bestSpace) { bestSpace = space; best = d; }
    }
    return { dir: best };
  },
};
