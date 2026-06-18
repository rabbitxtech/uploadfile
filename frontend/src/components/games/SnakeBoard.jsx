// Snake Duel renderer + input. Server-authoritative (services/games/snake.js): we
// draw the snapshot and send a direction on arrow/WASD or the on-screen d-pad.
// Your own snake is highlighted so you can tell the two apart.
import { useEffect, useRef } from 'react';

const PX = 22; // px per cell on the canvas
const COLORS = [
  { body: '#4ade80', head: '#bbf7d0' }, // player 0 — green
  { body: '#38bdf8', head: '#bae6fd' }, // player 1 — sky
];

export default function SnakeBoard({ room, onInput }) {
  const canvasRef = useRef(null);
  const grid = room.grid || 22;
  const size = grid * PX;

  useEffect(() => {
    const ctx = canvasRef.current?.getContext('2d');
    if (!ctx) return;
    ctx.fillStyle = '#0f1f12';
    ctx.fillRect(0, 0, size, size);
    // Grid.
    ctx.strokeStyle = 'rgba(74,222,128,0.08)';
    ctx.lineWidth = 1;
    for (let i = 1; i < grid; i += 1) {
      ctx.beginPath();
      ctx.moveTo(i * PX, 0);
      ctx.lineTo(i * PX, size);
      ctx.moveTo(0, i * PX);
      ctx.lineTo(size, i * PX);
      ctx.stroke();
    }
    // Food.
    if (room.food) {
      ctx.fillStyle = '#ef4444';
      ctx.fillRect(room.food.x * PX + 3, room.food.y * PX + 3, PX - 6, PX - 6);
    }
    // Snakes.
    (room.snakes || []).forEach((s, i) => {
      const col = COLORS[i] || COLORS[0];
      s.body.forEach((c, j) => {
        ctx.fillStyle = j === 0 ? col.head : col.body;
        ctx.globalAlpha = s.alive ? 1 : 0.35;
        ctx.fillRect(c.x * PX + 1, c.y * PX + 1, PX - 2, PX - 2);
      });
      ctx.globalAlpha = 1;
      // Ring the head of your own snake.
      if (i === room.youIndex && s.body[0]) {
        ctx.strokeStyle = '#fde047';
        ctx.lineWidth = 2;
        ctx.strokeRect(s.body[0].x * PX + 1, s.body[0].y * PX + 1, PX - 2, PX - 2);
      }
    });
  }, [room, grid, size]);

  useEffect(() => {
    const down = (e) => {
      const map = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', w: 'up', s: 'down', a: 'left', d: 'right' };
      const dir = map[e.key];
      if (dir) {
        e.preventDefault();
        onInput({ dir });
      }
    };
    window.addEventListener('keydown', down);
    return () => window.removeEventListener('keydown', down);
  }, [onInput]);

  const Pad = ({ dir, label, cls }) => (
    <button
      type="button"
      onClick={() => onInput({ dir })}
      className={`flex h-12 w-12 items-center justify-center rounded-lg bg-slate-200 text-lg font-bold text-slate-700 active:bg-slate-300 dark:bg-slate-700 dark:text-slate-200 ${cls}`}
      aria-label={dir}
    >
      {label}
    </button>
  );

  return (
    <div className="flex flex-col items-center gap-3">
      <canvas
        ref={canvasRef}
        width={size}
        height={size}
        className="w-full max-w-[600px] touch-none rounded-lg border-2 border-emerald-900/50 shadow-md"
        style={{ imageRendering: 'pixelated' }}
      />
      {/* Touch d-pad (hidden on pointer-fine screens via md:hidden). */}
      <div className="grid grid-cols-3 grid-rows-2 gap-1 md:hidden">
        <Pad dir="up" label="↑" cls="col-start-2" />
        <Pad dir="left" label="←" cls="col-start-1 row-start-2" />
        <Pad dir="down" label="↓" cls="col-start-2 row-start-2" />
        <Pad dir="right" label="→" cls="col-start-3 row-start-2" />
      </div>
    </div>
  );
}
