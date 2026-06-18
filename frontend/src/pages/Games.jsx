// Multiplayer 2D pixel games. The lobby lets you create a private room (share a
// code / link), quick-match a stranger, or join by code. Rooms run over the /gws
// socket (server-authoritative). Caro/Gomoku is playable today; Pong, Snake and
// Chess are scaffolded as "coming soon" so the page is ready to grow into them.
import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import {
  Gamepad2, Users, Plus, Zap, LogIn, Copy, Link as LinkIcon,
  RotateCcw, DoorOpen, Send, Wifi, WifiOff, Loader2, Bot,
} from 'lucide-react';
import { useGameClient } from '../lib/games.js';
import { copyText } from '../lib/uid.js';
import GomokuBoard from '../components/games/GomokuBoard.jsx';
import PongBoard from '../components/games/PongBoard.jsx';
import SnakeBoard from '../components/games/SnakeBoard.jsx';
import ChessBoard from '../components/games/ChessBoard.jsx';
import TicTacToeBoard from '../components/games/TicTacToeBoard.jsx';
import Connect4Board from '../components/games/Connect4Board.jsx';
import ReversiBoard from '../components/games/ReversiBoard.jsx';
import TronBoard from '../components/games/TronBoard.jsx';
import Nim21Board from '../components/games/Nim21Board.jsx';
import RpsBoard from '../components/games/RpsBoard.jsx';
import MemoryBoard from '../components/games/MemoryBoard.jsx';
import GameThumb from '../components/games/GameThumb.jsx';

const CATALOG = [
  { id: 'gomoku', ready: true },
  { id: 'tictactoe', ready: true },
  { id: 'connect4', ready: true },
  { id: 'reversi', ready: true },
  { id: 'chess', ready: true },
  { id: 'pong', ready: true },
  { id: 'snake', ready: true },
  { id: 'tron', ready: true },
  { id: 'nim21', ready: true },
  { id: 'rps', ready: true },
  { id: 'memory', ready: true },
];

export default function Games() {
  const { t } = useTranslation();
  const { client, status } = useGameClient();
  const [params, setParams] = useSearchParams();
  const [room, setRoom] = useState(null);
  const [waiting, setWaiting] = useState(null); // game id while matchmaking
  const [active, setActive] = useState('gomoku'); // selected lobby game
  const [code, setCode] = useState('');
  const [chat, setChat] = useState([]);
  const [chatInput, setChatInput] = useState('');
  const chatEndRef = useRef(null);
  const autoJoined = useRef(false);

  // Incoming server messages.
  useEffect(() => {
    if (!client) return undefined;
    return client.on((msg) => {
      if (msg.type === 'room') {
        setWaiting(null);
        setRoom(msg);
      } else if (msg.type === 'waiting') {
        setWaiting(msg.game);
      } else if (msg.type === 'error') {
        toast.error(msg.message || t('games.error'));
        setWaiting(null);
      } else if (msg.type === 'opponentLeft') {
        toast(t('games.opponentLeft'), { icon: '👋' });
      } else if (msg.type === 'chat') {
        setChat((c) => [...c.slice(-49), msg]);
      }
    });
  }, [client, t]);

  // Auto-join a shared room link: /games?room=CODE (once, after we connect).
  useEffect(() => {
    const shared = params.get('room');
    if (shared && client && status === 'online' && !room && !autoJoined.current) {
      autoJoined.current = true;
      client.send({ type: 'join', code: shared });
    }
  }, [params, client, status, room]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ block: 'nearest' });
  }, [chat]);

  const leaveRoom = () => {
    client?.send({ type: 'leave' });
    setRoom(null);
    setChat([]);
    if (params.get('room')) {
      params.delete('room');
      setParams(params, { replace: true });
    }
    autoJoined.current = false;
  };

  const shareLink = room ? `${location.origin}/games?room=${room.code}` : '';

  // ---- Lobby ---------------------------------------------------------------
  if (!room && !waiting) {
    return (
      <div className="mx-auto max-w-5xl">
        <h1 className="mb-1 flex items-center gap-2 text-xl font-semibold text-slate-900 dark:text-slate-100">
          <Gamepad2 className="h-6 w-6" /> {t('games.title')}
        </h1>
        <p className="mb-5 text-sm text-slate-500 dark:text-slate-400">{t('games.subtitle')}</p>

        <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {CATALOG.map((g) => (
            <button
              key={g.id}
              type="button"
              disabled={!g.ready}
              onClick={() => g.ready && setActive(g.id)}
              className={`group flex flex-col items-center gap-2 rounded-xl border p-4 transition-colors ${
                active === g.id && g.ready
                  ? 'border-indigo-500 bg-indigo-50 dark:border-indigo-400 dark:bg-indigo-500/10'
                  : 'border-slate-200 bg-white hover:border-slate-300 dark:border-slate-700 dark:bg-slate-800'
              } ${g.ready ? '' : 'cursor-not-allowed opacity-60'}`}
            >
              <GameThumb
                game={g.id}
                className="h-16 w-16 transition-transform group-hover:scale-105 group-disabled:grayscale"
              />
              <span className="text-sm font-medium text-slate-800 dark:text-slate-200">{t(`games.catalog.${g.id}`)}</span>
              {!g.ready && <span className="text-[10px] uppercase tracking-wide text-slate-400">{t('games.comingSoon')}</span>}
            </button>
          ))}
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-800">
          <div className="mb-3 flex items-center gap-2 text-sm font-medium text-slate-700 dark:text-slate-200">
            {t('games.play', { game: t(`games.catalog.${active}`) })}
            <span className="ml-auto inline-flex items-center gap-1 text-xs text-slate-400">
              {status === 'online' ? <Wifi className="h-3.5 w-3.5 text-emerald-500" /> : <WifiOff className="h-3.5 w-3.5 text-amber-500" />}
              {t(`games.conn.${status}`)}
            </span>
          </div>
          <div className="flex flex-col gap-3 sm:flex-row">
            <button onClick={() => client?.send({ type: 'createBot', game: active })} className="btn-primary flex-1 justify-center" disabled={status !== 'online'}>
              <Bot className="h-4 w-4" /> {t('games.playVsCpu')}
            </button>
            <button onClick={() => client?.send({ type: 'quickmatch', game: active })} className="btn-secondary flex-1 justify-center" disabled={status !== 'online'}>
              <Zap className="h-4 w-4" /> {t('games.quickMatch')}
            </button>
            <button onClick={() => client?.send({ type: 'create', game: active })} className="btn-secondary flex-1 justify-center" disabled={status !== 'online'}>
              <Plus className="h-4 w-4" /> {t('games.createRoom')}
            </button>
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (code.trim()) client?.send({ type: 'join', code: code.trim().toUpperCase() });
            }}
            className="mt-3 flex gap-2"
          >
            <input
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              maxLength={4}
              placeholder={t('games.codePlaceholder')}
              className="input w-32 text-center font-mono tracking-widest"
            />
            <button type="submit" className="btn-secondary" disabled={status !== 'online' || !code.trim()}>
              <LogIn className="h-4 w-4" /> {t('games.joinRoom')}
            </button>
          </form>
        </div>
      </div>
    );
  }

  // ---- Matchmaking wait ----------------------------------------------------
  if (waiting) {
    return (
      <div className="mx-auto max-w-md py-16 text-center">
        <Loader2 className="mx-auto mb-4 h-10 w-10 animate-spin text-indigo-500" />
        <p className="mb-1 text-lg font-medium text-slate-800 dark:text-slate-100">{t('games.searching')}</p>
        <p className="mb-6 text-sm text-slate-500 dark:text-slate-400">{t(`games.catalog.${waiting}`)}</p>
        <button
          onClick={() => {
            client?.send({ type: 'cancel' });
            setWaiting(null);
          }}
          className="btn-secondary"
        >
          {t('games.cancel')}
        </button>
      </div>
    );
  }

  // ---- In a room -----------------------------------------------------------
  const me = room.youIndex;
  const full = room.players.length >= 2;
  const turnBased = room.turn === 0 || room.turn === 1; // realtime games omit turn
  const myTurn = room.status === 'playing' && turnBased && room.turn === me;
  const play = (m) => client?.send({ type: 'move', ...m });

  let banner = '';
  if (room.status === 'waiting') banner = t('games.waitingOpponent');
  else if (room.status === 'playing') banner = turnBased ? (myTurn ? t('games.yourTurn') : t('games.opponentTurn')) : t('games.playing');
  else if (room.status === 'over') {
    if (room.winner === 'draw') banner = t('games.draw');
    else banner = room.winner === me ? t('games.youWin') : t('games.youLose');
  }

  return (
    <div className="mx-auto max-w-6xl">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <button onClick={leaveRoom} className="btn-secondary py-1.5 text-sm">
          <DoorOpen className="h-4 w-4" /> {t('games.leave')}
        </button>
        <span className="inline-flex items-center gap-1 rounded-md bg-slate-100 px-2 py-1 font-mono text-sm font-semibold tracking-widest text-slate-700 dark:bg-slate-700 dark:text-slate-200">
          {room.code}
        </span>
        <button onClick={() => copyText(room.code).then(() => toast.success(t('games.copied')))} className="rounded-md p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-300 dark:hover:bg-slate-700 dark:hover:text-white" title={t('games.copyCode')}>
          <Copy className="h-4 w-4" />
        </button>
        <button onClick={() => copyText(shareLink).then(() => toast.success(t('games.linkCopied')))} className="rounded-md p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-300 dark:hover:bg-slate-700 dark:hover:text-white" title={t('games.copyLink')}>
          <LinkIcon className="h-4 w-4" />
        </button>
        <span className="ml-auto inline-flex items-center gap-1 text-xs text-slate-400">
          {status === 'online' ? <Wifi className="h-3.5 w-3.5 text-emerald-500" /> : <WifiOff className="h-3.5 w-3.5 text-amber-500" />}
        </span>
      </div>

      <div className={`grid gap-4 ${room.vsBot ? '' : 'md:grid-cols-[1fr_260px]'}`}>
        <div>
          {/* Scoreboard */}
          <div className="mb-3 flex items-center justify-center gap-3 text-sm">
            <PlayerChip color={0} name={room.players[0]?.name} you={me === 0} active={room.status === 'playing' && room.turn === 0} />
            <span className="text-slate-400">vs</span>
            {full ? (
              <PlayerChip color={1} name={room.players[1]?.name} you={me === 1} active={room.status === 'playing' && room.turn === 1} />
            ) : (
              <span className="rounded-md border border-dashed border-slate-300 px-3 py-1 text-slate-400 dark:border-slate-600">{t('games.empty')}</span>
            )}
          </div>

          <div
            className={`mb-3 rounded-lg px-4 py-2 text-center text-sm font-medium ${
              room.status === 'over'
                ? room.winner === me
                  ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300'
                  : room.winner === 'draw'
                    ? 'bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-300'
                    : 'bg-rose-100 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300'
                : myTurn
                  ? 'bg-indigo-100 text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300'
                  : 'bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-300'
            }`}
          >
            {banner}
          </div>

          {room.game === 'gomoku' && (
            <GomokuBoard board={room.board} line={room.line} myIndex={me} turn={room.turn} status={room.status} onPlay={(r, c) => play({ r, c })} />
          )}
          {room.game === 'pong' && <PongBoard room={room} onInput={play} />}
          {room.game === 'snake' && <SnakeBoard room={room} onInput={play} />}
          {room.game === 'chess' && <ChessBoard room={room} onMove={play} />}
          {room.game === 'tictactoe' && <TicTacToeBoard room={room} onPlay={play} />}
          {room.game === 'connect4' && <Connect4Board room={room} onPlay={play} />}
          {room.game === 'reversi' && <ReversiBoard room={room} onPlay={play} />}
          {room.game === 'tron' && <TronBoard room={room} onInput={play} />}
          {room.game === 'nim21' && <Nim21Board room={room} onPlay={play} />}
          {room.game === 'rps' && <RpsBoard room={room} onPlay={play} />}
          {room.game === 'memory' && <MemoryBoard room={room} onPlay={play} />}

          <p className="mt-2 text-center text-xs text-slate-400">{t(`games.controls.${room.game}`)}</p>

          {room.status === 'over' && full && (
            <div className="mt-3 text-center">
              <button onClick={() => client?.send({ type: 'rematch' })} className="btn-primary">
                <RotateCcw className="h-4 w-4" /> {t('games.rematch')}
              </button>
            </div>
          )}
        </div>

        {/* Chat — only in player-vs-player rooms (the CPU doesn't chat). */}
        {!room.vsBot && (
        <div className="flex h-[360px] flex-col rounded-lg border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-800 md:h-auto">
          <div className="flex items-center gap-1 border-b border-slate-200 px-3 py-2 text-xs font-medium text-slate-500 dark:border-slate-700 dark:text-slate-400">
            <Users className="h-3.5 w-3.5" /> {t('games.chat')}
          </div>
          <div className="flex-1 space-y-1 overflow-y-auto p-3 text-sm">
            {chat.length === 0 && <p className="text-xs text-slate-400">{t('games.chatEmpty')}</p>}
            {chat.map((m, i) => (
              <div key={i} className="break-words">
                <span className="font-medium text-slate-700 dark:text-slate-300">{m.from}: </span>
                <span className="text-slate-600 dark:text-slate-400">{m.text}</span>
              </div>
            ))}
            <div ref={chatEndRef} />
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (chatInput.trim()) {
                client?.send({ type: 'chat', text: chatInput.trim() });
                setChatInput('');
              }
            }}
            className="flex gap-1 border-t border-slate-200 p-2 dark:border-slate-700"
          >
            <input
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              maxLength={300}
              placeholder={t('games.chatPlaceholder')}
              className="input flex-1 text-sm"
            />
            <button type="submit" className="btn-primary px-2" aria-label={t('games.send')}>
              <Send className="h-4 w-4" />
            </button>
          </form>
        </div>
        )}
      </div>
    </div>
  );
}

function PlayerChip({ color, name, you, active }) {
  const { t } = useTranslation();
  const dot = color === 0 ? 'bg-slate-800 dark:bg-slate-300' : 'bg-red-500';
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1 ${active ? 'ring-2 ring-indigo-400' : ''} bg-slate-100 dark:bg-slate-700`}>
      <span className={`h-3 w-3 rounded-sm ${dot}`} style={{ imageRendering: 'pixelated' }} />
      <span className="font-medium text-slate-700 dark:text-slate-200">{name || '—'}</span>
      {you && <span className="text-xs text-indigo-500">({t('games.you')})</span>}
    </span>
  );
}
