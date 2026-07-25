// Pixel-art thumbnails for the games lobby — hand-authored SVG (crispEdges, so it
// stays sharp at any size and themes with the page, no raster assets). One mini
// scene per game: a caro board mid-game, a pong rally, a snake chasing an apple,
// a chessboard with two pawns.
const VB = '0 0 64 64';

function Gomoku() {
  const lines = [13, 23, 33, 43, 53];
  // [x, y, colorIndex] on grid intersections; 0 = dark stone, 1 = red stone.
  const stones = [
    [23, 33, 0], [33, 43, 0], [43, 33, 0], [33, 23, 0],
    [13, 13, 1], [23, 23, 1], [33, 33, 1], [43, 43, 1], [53, 53, 1],
  ];
  const fill = ['#1f2937', '#ef4444'];
  const bevel = ['#4b5563', '#fca5a5'];
  return (
    <svg viewBox={VB} shapeRendering="crispEdges" className="h-full w-full">
      <rect width="64" height="64" fill="#e3b873" />
      <g stroke="#9a6b2f" strokeWidth="1">
        {lines.map((p) => <line key={`h${p}`} x1="13" y1={p} x2="53" y2={p} />)}
        {lines.map((p) => <line key={`v${p}`} x1={p} y1="13" x2={p} y2="53" />)}
      </g>
      {/* winning diagonal glow (the red 5-in-a-row) */}
      {stones.filter((s) => s[2] === 1).map(([x, y]) => (
        <rect key={`g${x}${y}`} x={x - 6} y={y - 6} width="12" height="12" fill="#facc15" opacity="0.45" />
      ))}
      {stones.map(([x, y, ci]) => (
        <g key={`${x}-${y}`}>
          <rect x={x - 4} y={y - 4} width="8" height="8" fill={fill[ci]} />
          <rect x={x - 4} y={y - 4} width="8" height="2" fill={bevel[ci]} />
          <rect x={x - 4} y={y - 4} width="2" height="8" fill={bevel[ci]} />
        </g>
      ))}
    </svg>
  );
}

function Pong() {
  return (
    <svg viewBox={VB} shapeRendering="crispEdges" className="h-full w-full">
      <rect width="64" height="64" fill="#0b1020" />
      {[8, 20, 32, 44, 56].map((y) => <rect key={y} x="31" y={y} width="2" height="6" fill="#334155" />)}
      <rect x="5" y="18" width="5" height="20" fill="#e2e8f0" />
      <rect x="54" y="30" width="5" height="20" fill="#e2e8f0" />
      <rect x="33" y="27" width="6" height="6" fill="#fde047" />
      <rect x="40" y="33" width="4" height="4" fill="#fde047" opacity="0.5" />
    </svg>
  );
}

function Snake() {
  // Body squares (8px grid) forming an L-shaped trail; head is brighter.
  const body = [[10, 42], [18, 42], [26, 42], [26, 34], [26, 26], [34, 26]];
  return (
    <svg viewBox={VB} shapeRendering="crispEdges" className="h-full w-full">
      <rect width="64" height="64" fill="#0f1f12" />
      <g opacity="0.18" stroke="#4ade80" strokeWidth="1">
        {[16, 32, 48].map((p) => <line key={`r${p}`} x1="0" y1={p} x2="64" y2={p} />)}
        {[16, 32, 48].map((p) => <line key={`c${p}`} x1={p} y1="0" x2={p} y2="64" />)}
      </g>
      {body.map(([x, y], i) => (
        <rect key={`${x}-${y}`} x={x} y={y} width="7" height="7" fill={i === body.length - 1 ? '#86efac' : '#4ade80'} />
      ))}
      {/* eye on the head */}
      <rect x="39" y="28" width="2" height="2" fill="#0f1f12" />
      {/* apple */}
      <rect x="46" y="46" width="7" height="7" fill="#ef4444" />
      <rect x="48" y="44" width="2" height="3" fill="#16a34a" />
    </svg>
  );
}

function Chess() {
  const sq = 8;
  const cells = [];
  for (let r = 0; r < 8; r += 1) {
    for (let c = 0; c < 8; c += 1) {
      cells.push(
        <rect key={`${r}-${c}`} x={c * sq} y={r * sq} width={sq} height={sq} fill={(r + c) % 2 ? '#7c8597' : '#d7dde8'} />,
      );
    }
  }
  // Tiny pixel pawn built from rects, drawn at (ox,oy).
  const pawn = (ox, oy, color) => (
    <g fill={color}>
      <rect x={ox + 2} y={oy} width="4" height="3" />
      <rect x={ox + 1} y={oy + 3} width="6" height="2" />
      <rect x={ox + 2} y={oy + 5} width="4" height="2" />
      <rect x={ox} y={oy + 7} width="8" height="2" />
    </g>
  );
  return (
    <svg viewBox={VB} shapeRendering="crispEdges" className="h-full w-full">
      {cells}
      {pawn(12, 14, '#f8fafc')}
      {pawn(44, 40, '#0f172a')}
    </svg>
  );
}

function TicTacToe() {
  return (
    <svg viewBox={VB} shapeRendering="crispEdges" className="h-full w-full">
      <rect width="64" height="64" fill="#f1f5f9" />
      <g stroke="#94a3b8" strokeWidth="2">
        <line x1="22" y1="6" x2="22" y2="58" /><line x1="42" y1="6" x2="42" y2="58" />
        <line x1="6" y1="22" x2="58" y2="22" /><line x1="6" y1="42" x2="58" y2="42" />
      </g>
      <g stroke="#f43f5e" strokeWidth="4" strokeLinecap="round">
        <line x1="9" y1="9" x2="19" y2="19" /><line x1="19" y1="9" x2="9" y2="19" />
        <line x1="49" y1="29" x2="59" y2="39" /><line x1="59" y1="29" x2="49" y2="39" />
      </g>
      <circle cx="32" cy="32" r="6" fill="none" stroke="#0ea5e9" strokeWidth="4" />
      <circle cx="14" cy="52" r="6" fill="none" stroke="#0ea5e9" strokeWidth="4" />
    </svg>
  );
}

function Connect4() {
  const discs = [[1, 5, 1], [2, 5, 2], [2, 4, 1], [3, 5, 1], [3, 4, 2], [3, 3, 1], [4, 5, 2], [5, 5, 2]];
  const col = ['', '#ef4444', '#facc15'];
  return (
    <svg viewBox={VB} shapeRendering="crispEdges" className="h-full w-full">
      <rect width="64" height="64" fill="#1d4ed8" />
      {[...Array(6)].map((_, r) => [...Array(7)].map((__, c) => (
        <circle key={`${r}-${c}`} cx={5 + c * 9} cy={6 + r * 9} r="3.4" fill="#0b1e54" />
      )))}
      {discs.map(([r, c, p]) => <circle key={`d${r}${c}`} cx={5 + c * 9} cy={6 + r * 9} r="3.4" fill={col[p]} />)}
    </svg>
  );
}

function Reversi() {
  const discs = [[3, 3, 2], [3, 4, 1], [4, 3, 1], [4, 4, 2], [2, 4, 1], [5, 3, 2], [3, 5, 1]];
  return (
    <svg viewBox={VB} shapeRendering="crispEdges" className="h-full w-full">
      <rect width="64" height="64" fill="#047857" />
      <g stroke="#065f46" strokeWidth="1">
        {[...Array(7)].map((_, i) => <line key={`v${i}`} x1={8 * (i + 1)} y1="0" x2={8 * (i + 1)} y2="64" />)}
        {[...Array(7)].map((_, i) => <line key={`h${i}`} x1="0" y1={8 * (i + 1)} x2="64" y2={8 * (i + 1)} />)}
      </g>
      {discs.map(([r, c, p]) => <circle key={`${r}-${c}`} cx={c * 8 + 4} cy={r * 8 + 4} r="3" fill={p === 1 ? '#0f172a' : '#f8fafc'} />)}
    </svg>
  );
}

function Tron() {
  return (
    <svg viewBox={VB} shapeRendering="crispEdges" className="h-full w-full">
      <rect width="64" height="64" fill="#0a0a16" />
      {/* cyan trail */}
      <g fill="#06b6d4">
        <rect x="8" y="44" width="24" height="5" /><rect x="27" y="20" width="5" height="29" /><rect x="27" y="20" width="20" height="5" />
      </g>
      <rect x="43" y="20" width="5" height="5" fill="#a5f3fc" />
      {/* orange trail */}
      <g fill="#f97316">
        <rect x="32" y="12" width="24" height="5" /><rect x="32" y="12" width="5" height="24" /><rect x="20" y="32" width="17" height="5" />
      </g>
      <rect x="20" y="32" width="5" height="5" fill="#fed7aa" />
    </svg>
  );
}

function Nim21() {
  return (
    <svg viewBox={VB} shapeRendering="crispEdges" className="h-full w-full">
      <rect width="64" height="64" fill="#fffbeb" />
      {[6, 13, 20, 27, 34, 41, 48].map((x, i) => (
        <rect key={x} x={x} y={i % 2 ? 16 : 22} width="4" height={i % 2 ? 36 : 30} rx="1" fill={i < 4 ? '#d97706' : '#b45309'} />
      ))}
      <text x="32" y="60" textAnchor="middle" fontSize="9" fontWeight="bold" fill="#92400e">21</text>
    </svg>
  );
}

function Rps() {
  return (
    <svg viewBox={VB} className="h-full w-full">
      <rect width="64" height="64" fill="#eef2ff" />
      <text x="14" y="30" textAnchor="middle" fontSize="20">✊</text>
      <text x="50" y="30" textAnchor="middle" fontSize="20">✌️</text>
      <text x="32" y="56" textAnchor="middle" fontSize="20">✋</text>
    </svg>
  );
}

function Memory() {
  const cells = [];
  const faces = { 1: '🍎', 4: '🍇', 6: '🍒' };
  for (let i = 0; i < 9; i += 1) {
    const x = 6 + (i % 3) * 18;
    const y = 6 + Math.floor(i / 3) * 18;
    cells.push(<rect key={`r${i}`} x={x} y={y} width="15" height="15" rx="2" fill={faces[i] ? '#ffffff' : '#6366f1'} stroke="#4338ca" strokeWidth="1" />);
    if (faces[i]) cells.push(<text key={`t${i}`} x={x + 7.5} y={y + 12} textAnchor="middle" fontSize="11">{faces[i]}</text>);
    else cells.push(<text key={`q${i}`} x={x + 7.5} y={y + 12} textAnchor="middle" fontSize="10" fill="#c7d2fe" fontWeight="bold">?</text>);
  }
  return (
    <svg viewBox={VB} className="h-full w-full">
      <rect width="64" height="64" fill="#e0e7ff" />
      {cells}
    </svg>
  );
}

function Rpg() {
  return (
    <svg viewBox={VB} className="h-full w-full">
      <defs>
        <radialGradient id="rpgbg" cx="50%" cy="40%" r="75%">
          <stop offset="0%" stopColor="#1b3a2a" /><stop offset="100%" stopColor="#0c1c14" />
        </radialGradient>
      </defs>
      <rect width="64" height="64" fill="url(#rpgbg)" />
      {/* core shard glow + diamond */}
      <circle cx="50" cy="20" r="9" fill="#fde047" opacity="0.3" />
      <rect x="46" y="14" width="9" height="9" rx="1.5" fill="#fbbf24" stroke="#b45309" transform="rotate(45 50 18)" />
      {/* enemy slime */}
      <ellipse cx="47" cy="48" rx="7" ry="6" fill="#84cc16" stroke="#16270a" strokeWidth="1.5" />
      <circle cx="48" cy="47" r="2.4" fill="#fff" /><circle cx="48.6" cy="47" r="1.2" fill="#15240a" />
      {/* chibi adventurer in a teal coat (avatar.jpg) */}
      <ellipse cx="22" cy="52" rx="3.4" ry="2" fill="#000" opacity="0.3" />
      {/* legs */}
      <ellipse cx="19" cy="48" rx="2.2" ry="3.4" fill="#2b303c" stroke="#13161f" strokeWidth="1.2" />
      <ellipse cx="25" cy="48" rx="2.2" ry="3.4" fill="#2b303c" stroke="#13161f" strokeWidth="1.2" />
      {/* dark-red shirt */}
      <ellipse cx="22" cy="42" rx="5.5" ry="7" fill="#7c1d2b" stroke="#13161f" strokeWidth="1.5" />
      {/* open teal coat panels + collar */}
      <path d="M16 36 l5 2 -1 11 -4.5 -1.5 z" fill="#1f7a8c" stroke="#13161f" strokeWidth="1.2" />
      <path d="M28 36 l-5 2 1 11 4.5 -1.5 z" fill="#1f7a8c" stroke="#13161f" strokeWidth="1.2" />
      <path d="M17 35 l5 3 5 -3 -2.5 -2.5 -5 0 z" fill="#46b3c2" />
      {/* head */}
      <ellipse cx="22" cy="31" rx="8.5" ry="8.8" fill="#f3c79a" stroke="#13161f" strokeWidth="1.5" />
      {/* black spiky hair */}
      <path d="M13 30 L14 22 17 27 19 19 22 26 24 18 27 26 29 20 31 27 32 30 28 28 22 26 17 28 z" fill="#222a3a" stroke="#13161f" strokeWidth="1" />
      <rect x="18.5" y="31" width="2" height="3" fill="#13161f" /><rect x="23.5" y="31" width="2" height="3" fill="#13161f" />
    </svg>
  );
}

const THUMBS = {
  gomoku: Gomoku, pong: Pong, snake: Snake, chess: Chess, tictactoe: TicTacToe,
  connect4: Connect4, reversi: Reversi, tron: Tron, nim21: Nim21, rps: Rps, memory: Memory, rpg: Rpg,
};

export default function GameThumb({ game, className = '' }) {
  const Thumb = THUMBS[game] || Gomoku;
  return (
    <div
      className={`overflow-hidden rounded-lg border border-black/10 shadow-inner ring-1 ring-black/5 dark:border-white/10 ${className}`}
      style={{ imageRendering: 'pixelated' }}
    >
      <Thumb />
    </div>
  );
}
