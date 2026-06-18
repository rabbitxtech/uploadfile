// Snake Duel — realtime, server-authoritative on a GRID×GRID board. Each tick both
// snakes advance one cell in their current direction; a snake dies hitting a wall,
// any snake body (its own or the rival's), or in a head-on collision. Last snake
// alive wins; simultaneous death is a draw. Eating food grows you by one.
export const GRID = 22;
const START_LEN = 3;

const DIRS = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};
const OPPOSITE = { up: 'down', down: 'up', left: 'right', right: 'left' };

function spawnFood(state) {
  const taken = new Set();
  for (const s of state.snakes) for (const c of s.body) taken.add(`${c.x},${c.y}`);
  let x;
  let y;
  let guard = 0;
  do {
    x = Math.floor(Math.random() * GRID);
    y = Math.floor(Math.random() * GRID);
    guard += 1;
  } while (taken.has(`${x},${y}`) && guard < 500);
  state.food = { x, y };
}

function makeSnake(x, y, dir) {
  const d = DIRS[dir];
  // Body laid out behind the head so it doesn't start off-board.
  const body = [];
  for (let i = 0; i < START_LEN; i += 1) body.push({ x: x - d.x * i, y: y - d.y * i });
  return { body, dir, nextDir: dir, alive: true, grow: 0 };
}

export const engine = {
  tickMs: 130, // ~7.5 steps/sec
  newState() {
    return { status: 'waiting', winner: null, snakes: [], food: { x: 0, y: 0 }, grid: GRID };
  },
  ready(state) {
    const mid = Math.floor(GRID / 2);
    state.snakes = [
      makeSnake(4, mid, 'right'),
      makeSnake(GRID - 5, mid, 'left'),
    ];
    state.winner = null;
    state.status = 'playing';
    spawnFood(state);
  },
  input(state, idx, msg) {
    const s = state.snakes[idx];
    if (!s || !s.alive) return {};
    const dir = msg.dir;
    if (DIRS[dir] && dir !== OPPOSITE[s.dir]) s.nextDir = dir;
    return {};
  },
  tick(state) {
    if (state.status !== 'playing') return;
    const heads = [];
    // Compute each living snake's new head.
    state.snakes.forEach((s, i) => {
      if (!s.alive) { heads[i] = null; return; }
      s.dir = s.nextDir;
      const d = DIRS[s.dir];
      heads[i] = { x: s.body[0].x + d.x, y: s.body[0].y + d.y };
    });
    // Resolve collisions against the PRE-move bodies (classic snake timing).
    const occupied = new Set();
    for (const s of state.snakes) {
      if (!s.alive) continue;
      // The tail will move unless the snake grows; treat all current cells as solid
      // (simpler + safer than predicting tail vacancy under simultaneous moves).
      for (const c of s.body) occupied.add(`${c.x},${c.y}`);
    }
    const dead = [false, false];
    state.snakes.forEach((s, i) => {
      const h = heads[i];
      if (!s.alive || !h) return;
      if (h.x < 0 || h.x >= GRID || h.y < 0 || h.y >= GRID) dead[i] = true;
      else if (occupied.has(`${h.x},${h.y}`)) dead[i] = true;
    });
    // Head-on into the same cell → both die.
    if (heads[0] && heads[1] && heads[0].x === heads[1].x && heads[0].y === heads[1].y) {
      dead[0] = true;
      dead[1] = true;
    }
    // Apply: grow/move the survivors, kill the rest.
    state.snakes.forEach((s, i) => {
      if (!s.alive) return;
      if (dead[i]) { s.alive = false; return; }
      s.body.unshift(heads[i]);
      if (state.food && heads[i].x === state.food.x && heads[i].y === state.food.y) {
        s.grow += 2;
        spawnFood(state);
      }
      if (s.grow > 0) s.grow -= 1;
      else s.body.pop();
    });
    // Win/draw resolution.
    const alive = state.snakes.map((s) => s.alive);
    if (!alive[0] && !alive[1]) {
      state.status = 'over';
      state.winner = 'draw';
    } else if (!alive[0] || !alive[1]) {
      state.status = 'over';
      state.winner = alive[0] ? 0 : 1;
    }
  },
  view(state) {
    return {
      status: state.status,
      winner: state.winner,
      grid: state.grid,
      food: state.food,
      snakes: state.snakes.map((s) => ({ body: s.body, alive: s.alive })),
    };
  },
  // Greedy bot: head toward the food, but only among directions that don't kill
  // it next tick (wall or any snake body). Falls back to any non-reversing dir.
  bot(state, idx) {
    const me = state.snakes[idx];
    if (!me || !me.alive) return null;
    const head = me.body[0];
    const occupied = new Set();
    for (const s of state.snakes) for (const c of s.body) occupied.add(`${c.x},${c.y}`);
    const options = ['up', 'down', 'left', 'right'].filter((d) => d !== OPPOSITE[me.dir]);
    const isSafe = (d) => {
      const v = DIRS[d];
      const nx = head.x + v.x;
      const ny = head.y + v.y;
      if (nx < 0 || nx >= GRID || ny < 0 || ny >= GRID) return false;
      return !occupied.has(`${nx},${ny}`);
    };
    const pool = options.filter(isSafe);
    const dirs = pool.length ? pool : options;
    let best = dirs[0];
    let bestDist = Infinity;
    for (const d of dirs) {
      const v = DIRS[d];
      const dist = Math.abs(head.x + v.x - state.food.x) + Math.abs(head.y + v.y - state.food.y);
      if (dist < bestDist) { bestDist = dist; best = d; }
    }
    return { dir: best };
  },
};
