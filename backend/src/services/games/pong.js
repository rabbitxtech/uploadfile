// Pong — realtime, server-authoritative. The server simulates the ball + paddles
// on a fixed tick and broadcasts positions; clients only send their paddle target
// (absolute Y from mouse/touch) or a keyboard direction. First to WIN_SCORE wins.
// Logical field is W×H units; the client scales it to its canvas.
export const W = 1000;
export const H = 600;
const PADDLE_H = 110;
const PADDLE_W = 16;
const PADDLE_SPEED = 14; // units/tick for keyboard control
const BALL_R = 12;
const BALL_SPEED = 11;
const SPEED_UP = 1.04; // ball accelerates a touch on every paddle hit
const MAX_VX = 26;
const WIN_SCORE = 7;

function launchBall(state, toLeft) {
  const angle = (Math.random() * 0.6 - 0.3); // shallow vertical spread
  const dir = toLeft ? -1 : 1;
  state.ball = {
    x: W / 2,
    y: H / 2,
    vx: dir * BALL_SPEED * Math.cos(angle),
    vy: BALL_SPEED * Math.sin(angle) + (Math.random() < 0.5 ? 1 : -1),
  };
}

export const engine = {
  tickMs: 33, // ~30 fps
  newState() {
    return {
      status: 'waiting',
      winner: null,
      paddles: [H / 2, H / 2], // paddle centre Y for player 0 (left) / 1 (right)
      vel: [0, 0], // keyboard velocity intent
      target: [null, null], // mouse/touch absolute target Y
      scores: [0, 0],
      ball: { x: W / 2, y: H / 2, vx: 0, vy: 0 },
    };
  },
  ready(state) {
    state.scores = [0, 0];
    state.paddles = [H / 2, H / 2];
    state.vel = [0, 0];
    state.target = [null, null];
    state.winner = null;
    state.status = 'playing';
    launchBall(state, Math.random() < 0.5);
  },
  input(state, idx, msg) {
    if (typeof msg.y === 'number') {
      state.target[idx] = Math.max(PADDLE_H / 2, Math.min(H - PADDLE_H / 2, msg.y));
      state.vel[idx] = 0;
    } else if (typeof msg.dir === 'number') {
      state.vel[idx] = Math.max(-1, Math.min(1, msg.dir)) * PADDLE_SPEED;
      state.target[idx] = null;
    }
    return {};
  },
  tick(state) {
    if (state.status !== 'playing') return;
    // Move paddles (mouse target wins over keyboard velocity).
    for (let i = 0; i < 2; i += 1) {
      if (state.target[i] != null) state.paddles[i] = state.target[i];
      else state.paddles[i] += state.vel[i];
      state.paddles[i] = Math.max(PADDLE_H / 2, Math.min(H - PADDLE_H / 2, state.paddles[i]));
    }
    const b = state.ball;
    b.x += b.vx;
    b.y += b.vy;
    // Top/bottom walls.
    if (b.y < BALL_R) { b.y = BALL_R; b.vy = Math.abs(b.vy); }
    if (b.y > H - BALL_R) { b.y = H - BALL_R; b.vy = -Math.abs(b.vy); }
    // Left paddle.
    if (b.vx < 0 && b.x - BALL_R < PADDLE_W + 10 && Math.abs(b.y - state.paddles[0]) < PADDLE_H / 2 + BALL_R) {
      b.x = PADDLE_W + 10 + BALL_R;
      b.vx = Math.min(MAX_VX, Math.abs(b.vx) * SPEED_UP);
      b.vy += (b.y - state.paddles[0]) / (PADDLE_H / 2) * 4;
    }
    // Right paddle.
    if (b.vx > 0 && b.x + BALL_R > W - PADDLE_W - 10 && Math.abs(b.y - state.paddles[1]) < PADDLE_H / 2 + BALL_R) {
      b.x = W - PADDLE_W - 10 - BALL_R;
      b.vx = -Math.min(MAX_VX, Math.abs(b.vx) * SPEED_UP);
      b.vy += (b.y - state.paddles[1]) / (PADDLE_H / 2) * 4;
    }
    // Score.
    if (b.x < -BALL_R) { state.scores[1] += 1; afterScore(state, true); }
    else if (b.x > W + BALL_R) { state.scores[0] += 1; afterScore(state, false); }
  },
  view(state) {
    return {
      status: state.status,
      winner: state.winner,
      ball: { x: Math.round(state.ball.x), y: Math.round(state.ball.y) },
      paddles: state.paddles.map((y) => Math.round(y)),
      scores: state.scores,
      field: { w: W, h: H, paddleH: PADDLE_H, paddleW: PADDLE_W, ballR: BALL_R, win: WIN_SCORE },
    };
  },
  // Bot returns a keyboard-style direction, so it moves at the same capped paddle
  // speed a human gets — chases the ball only when it's heading toward its side
  // (otherwise drifts to centre), which keeps it beatable.
  bot(state, idx) {
    const ball = state.ball;
    const py = state.paddles[idx];
    const approaching = (idx === 1 && ball.vx > 0) || (idx === 0 && ball.vx < 0);
    const aim = approaching ? ball.y : H / 2;
    if (Math.abs(aim - py) < 18) return { dir: 0 };
    return { dir: aim > py ? 1 : -1 };
  },
};

function afterScore(state, scorerWasRight) {
  if (state.scores[0] >= WIN_SCORE || state.scores[1] >= WIN_SCORE) {
    state.status = 'over';
    state.winner = state.scores[0] > state.scores[1] ? 0 : 1;
    state.ball.vx = 0;
    state.ball.vy = 0;
    return;
  }
  // Serve toward the player who was just scored on.
  launchBall(state, !scorerWasRight);
}
