import { pino } from 'pino';
import { env } from './env.js';

// Structured JSON logging in production; pretty, human output in development if
// `pino-pretty` is installed (optional — falls back to JSON if not).
let transport;
if (env.nodeEnv !== 'production') {
  try {
    // Only use the pretty transport when it's actually available.
    await import('pino-pretty');
    transport = { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:HH:MM:ss' } };
  } catch {
    transport = undefined;
  }
}

export const logger = pino({
  level: process.env.LOG_LEVEL || (env.nodeEnv === 'production' ? 'info' : 'debug'),
  ...(transport ? { transport } : {}),
});
