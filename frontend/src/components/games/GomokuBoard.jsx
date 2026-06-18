// Pixel-styled Gomoku (Cờ Caro) board on a <canvas>. The server is authoritative
// for moves and win detection; this just renders the board it's handed and emits
// a (row,col) when the local player clicks an empty cell on their turn.
import { useEffect, useRef } from 'react';

const BOARD = 15;
const CELL = 30; // px per cell
const PAD = 16; // outer padding
const SIZE = BOARD * CELL + PAD * 2;

// Pixel-ish stone: a filled square with a lighter top-left bevel + dark border.
function drawStone(ctx, x, y, color, bevel) {
  const m = 4; // inset from the grid cell
  ctx.fillStyle = color;
  ctx.fillRect(x + m, y + m, CELL - m * 2, CELL - m * 2);
  ctx.fillStyle = bevel;
  ctx.fillRect(x + m, y + m, CELL - m * 2, 3);
  ctx.fillRect(x + m, y + m, 3, CELL - m * 2);
  ctx.strokeStyle = 'rgba(0,0,0,0.55)';
  ctx.lineWidth = 2;
  ctx.strokeRect(x + m, y + m, CELL - m * 2, CELL - m * 2);
}

export default function GomokuBoard({ board, line, myIndex, turn, status, onPlay }) {
  const canvasRef = useRef(null);
  const hoverRef = useRef(null);

  // Colors per player index. 0 = dark slate, 1 = red — classic pixel game vibe.
  const stoneFill = ['#1f2937', '#ef4444'];
  const stoneBevel = ['#4b5563', '#fca5a5'];

  function draw() {
    const ctx = canvasRef.current?.getContext('2d');
    if (!ctx) return;
    // Board background (wood-ish amber).
    ctx.fillStyle = '#e9c987';
    ctx.fillRect(0, 0, SIZE, SIZE);
    // Grid lines.
    ctx.strokeStyle = 'rgba(80,50,10,0.55)';
    ctx.lineWidth = 1;
    for (let i = 0; i < BOARD; i += 1) {
      const p = PAD + i * CELL + CELL / 2;
      ctx.beginPath();
      ctx.moveTo(PAD + CELL / 2, p);
      ctx.lineTo(SIZE - PAD - CELL / 2, p);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(p, PAD + CELL / 2);
      ctx.lineTo(p, SIZE - PAD - CELL / 2);
      ctx.stroke();
    }
    // Stones.
    for (let r = 0; r < BOARD; r += 1) {
      for (let c = 0; c < BOARD; c += 1) {
        const v = board?.[r]?.[c];
        if (v) drawStone(ctx, PAD + c * CELL, PAD + r * CELL, stoneFill[v - 1], stoneBevel[v - 1]);
      }
    }
    // Winning line highlight.
    if (line?.length) {
      ctx.strokeStyle = '#facc15';
      ctx.lineWidth = 4;
      for (const [r, c] of line) {
        ctx.strokeRect(PAD + c * CELL + 3, PAD + r * CELL + 3, CELL - 6, CELL - 6);
      }
    }
    // Hover preview (own turn, empty cell).
    const hov = hoverRef.current;
    const myTurn = status === 'playing' && myIndex === turn;
    if (myTurn && hov && !board?.[hov.r]?.[hov.c]) {
      ctx.globalAlpha = 0.4;
      drawStone(ctx, PAD + hov.c * CELL, PAD + hov.r * CELL, stoneFill[myIndex], stoneBevel[myIndex]);
      ctx.globalAlpha = 1;
    }
  }

  useEffect(draw); // redraw on every prop change

  function cellAt(e) {
    const rect = canvasRef.current.getBoundingClientRect();
    const scale = SIZE / rect.width; // canvas may be CSS-scaled on small screens
    const x = (e.clientX - rect.left) * scale - PAD;
    const y = (e.clientY - rect.top) * scale - PAD;
    const c = Math.floor(x / CELL);
    const r = Math.floor(y / CELL);
    if (r < 0 || r >= BOARD || c < 0 || c >= BOARD) return null;
    return { r, c };
  }

  function handleClick(e) {
    if (status !== 'playing' || myIndex !== turn) return;
    const cell = cellAt(e);
    if (cell && !board?.[cell.r]?.[cell.c]) onPlay(cell.r, cell.c);
  }

  function handleMove(e) {
    hoverRef.current = cellAt(e);
    draw();
  }

  function handleLeave() {
    hoverRef.current = null;
    draw();
  }

  return (
    <canvas
      ref={canvasRef}
      width={SIZE}
      height={SIZE}
      onClick={handleClick}
      onMouseMove={handleMove}
      onMouseLeave={handleLeave}
      className="mx-auto w-full max-w-[640px] cursor-pointer touch-none rounded-lg border-2 border-amber-900/40 shadow-md"
      style={{ imageRendering: 'pixelated' }}
    />
  );
}
