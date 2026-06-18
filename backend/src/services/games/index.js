// Registry of game engines, keyed by the id the client sends. Each engine follows
// the same shape (see gomoku.js): { tickMs, newState, ready, input, tick?, view }.
import { engine as gomoku } from './gomoku.js';
import { engine as pong } from './pong.js';
import { engine as snake } from './snake.js';
import { engine as chess } from './chess.js';
import { engine as tictactoe } from './tictactoe.js';
import { engine as connect4 } from './connect4.js';
import { engine as reversi } from './reversi.js';
import { engine as tron } from './tron.js';
import { engine as nim21 } from './nim21.js';
import { engine as rps } from './rps.js';
import { engine as memory } from './memory.js';

export const ENGINES = { gomoku, pong, snake, chess, tictactoe, connect4, reversi, tron, nim21, rps, memory };

export function getEngine(id) {
  return ENGINES[id] || null;
}
