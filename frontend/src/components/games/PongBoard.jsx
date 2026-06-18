// Pong renderer + input. The server simulates everything (services/games/pong.js);
// this draws the latest snapshot and sends our paddle target (mouse/touch absolute
// Y) or a keyboard direction. The server maps our youIndex to the correct paddle.
import { useEffect, useMemo, useRef } from 'react';

export default function PongBoard({ room, onInput }) {
  const canvasRef = useRef(null);
  const lastSent = useRef(0);
  const field = useMemo(() => room.field || { w: 1000, h: 600, paddleH: 110, paddleW: 16, ballR: 12 }, [room.field]);

  // Draw the current snapshot.
  useEffect(() => {
    const ctx = canvasRef.current?.getContext('2d');
    if (!ctx) return;
    const { w, h, paddleH, paddleW, ballR } = field;
    ctx.fillStyle = '#0b1020';
    ctx.fillRect(0, 0, w, h);
    // Center dashed line.
    ctx.fillStyle = '#334155';
    for (let y = 10; y < h; y += 40) ctx.fillRect(w / 2 - 3, y, 6, 22);
    // Paddles.
    ctx.fillStyle = '#e2e8f0';
    const [p0, p1] = room.paddles || [h / 2, h / 2];
    ctx.fillRect(10, p0 - paddleH / 2, paddleW, paddleH);
    ctx.fillRect(w - 10 - paddleW, p1 - paddleH / 2, paddleW, paddleH);
    // Ball.
    if (room.ball) {
      ctx.fillStyle = '#fde047';
      ctx.fillRect(room.ball.x - ballR, room.ball.y - ballR, ballR * 2, ballR * 2);
    }
    // Scores.
    ctx.fillStyle = 'rgba(226,232,240,0.55)';
    ctx.font = 'bold 64px monospace';
    ctx.textAlign = 'center';
    const [s0, s1] = room.scores || [0, 0];
    ctx.fillText(String(s0), w / 2 - 80, 70);
    ctx.fillText(String(s1), w / 2 + 80, 70);
  }, [room, field]);

  // Keyboard control.
  useEffect(() => {
    const down = (e) => {
      if (e.key === 'ArrowUp' || e.key === 'w') onInput({ dir: -1 });
      else if (e.key === 'ArrowDown' || e.key === 's') onInput({ dir: 1 });
    };
    const up = (e) => {
      if (['ArrowUp', 'ArrowDown', 'w', 's'].includes(e.key)) onInput({ dir: 0 });
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, [onInput]);

  // Mouse / touch control → absolute paddle Y (throttled to ~one tick).
  const move = (clientY) => {
    const now = performance.now();
    if (now - lastSent.current < 25) return;
    lastSent.current = now;
    const rect = canvasRef.current.getBoundingClientRect();
    const y = ((clientY - rect.top) / rect.height) * field.h;
    onInput({ y: Math.max(0, Math.min(field.h, y)) });
  };

  return (
    <canvas
      ref={canvasRef}
      width={field.w}
      height={field.h}
      onMouseMove={(e) => move(e.clientY)}
      onTouchMove={(e) => move(e.touches[0].clientY)}
      className="mx-auto aspect-[5/3] w-full max-w-[760px] touch-none rounded-lg border-2 border-slate-700 bg-[#0b1020] shadow-md"
    />
  );
}
