import { ZodError } from 'zod';
import { HttpError } from '../utils/errors.js';

export function errorHandler(err, req, res, _next) {
  if (err instanceof ZodError) {
    return res.status(400).json({ error: 'Validation failed', details: err.flatten() });
  }
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: err.message, details: err.details });
  }
  // Prisma unique-constraint
  if (err?.code === 'P2002') {
    return res.status(409).json({ error: 'Duplicate value', details: err.meta });
  }
  console.error('[error]', err);
  res.status(500).json({ error: 'Internal server error' });
}

export function notFoundHandler(req, res) {
  res.status(404).json({ error: `Route not found: ${req.method} ${req.path}` });
}
