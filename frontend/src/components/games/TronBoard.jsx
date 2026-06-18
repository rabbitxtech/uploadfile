// Tron light-cycles renderer + input. Server-authoritative (services/games/tron.js):
// draw the trails and send a direction on arrow/WASD or the on-screen d-pad. Your
// own cycle head is ringed so you can tell the two apart.
import { useEffect, useRef } from 'react';

const PX = 16;
const COLORS = [
  { trail: '#06b6d4', head: '#a5f3fc' }, // player 0 — cyan
  { trail: '#f97316', head: '#fed7aa' }, // player 1 — orange
];

export default function TronBoard({ room, onInput }) {
  const canvasRef = useRef(null);
  const grid = room.grid || 28;
  const size = grid * PX;

  useEffect(() => {
    const ctx = canvasRef.current?.getContext('2d');
    if (!ctx) return;
    ctx.fillStyle = '#0a0a16';
    ctx.fillRect(0, 0, size, size);
    ctx.strokeStyle = 'rgba(56,189,248,0.07)';
    ctx.lineWidth = 1;
    for (let i = 1; i < grid; i += 1) {
      ctx.beginPath();
      ctx.moveTo(i * PX, 0);
      ctx.lineTo(i * PX, size);
      ctx.moveTo(0, i * PX);
      ctx.lineTo(size, i * PX);
      ctx.stroke();
    }
    (room.cycles || []).forEach((cy, i) => {
      const col = COLORS[i] || COLORS[0];
      ctx.globalAlpha = cy.alive ? 1 : 0.4;
      ctx.fillStyle = col.trail;
      cy.trail.forEach((c) => ctx.fillRect(c.x * PX, c.y * PX, PX, PX));
      if (cy.trail[0]) {
        ctx.fillStyle = col.head;
        ctx.fillRect(cy.trail[0].x * PX, cy.trail[0].y * PX, PX, PX);
        if (i === room.youIndex) {
          ctx.globalAlpha = 1;
          ctx.strokeStyle = '#fde047';
          ctx.lineWidth = 2;
          ctx.strokeRect(cy.trail[0].x * PX + 1, cy.trail[0].y * PX + 1, PX - 2, PX - 2);
        }
      }
      ctx.globalAlpha = 1;
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
    <button type="button" onClick={() => onInput({ dir })} className={`flex h-12 w-12 items-center justify-center rounded-lg bg-slate-200 text-lg font-bold text-slate-700 active:bg-slate-300 dark:bg-slate-700 dark:text-slate-200 ${cls}`} aria-label={dir}>
      {label}
    </button>
  );

  return (
    <div className="flex flex-col items-center gap-3">
      <canvas
        ref={canvasRef}
        width={size}
        height={size}
        className="w-full max-w-[620px] touch-none rounded-lg border-2 border-cyan-900/60 shadow-md"
        style={{ imageRendering: 'pixelated' }}
      />
      <div className="grid grid-cols-3 grid-rows-2 gap-1 md:hidden">
        <Pad dir="up" label="↑" cls="col-start-2" />
        <Pad dir="left" label="←" cls="col-start-1 row-start-2" />
        <Pad dir="down" label="↓" cls="col-start-2 row-start-2" />
        <Pad dir="right" label="→" cls="col-start-3 row-start-2" />
      </div>
    </div>
  );
}
