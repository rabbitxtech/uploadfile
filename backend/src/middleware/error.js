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
  // Malformed JSON body — express.json() throws a SyntaxError carrying the
  // request body. That is the client's mistake, so it must be a 400; falling
  // through to the 500 branch below would also log the raw body (possibly a
  // password) to stderr on every stray request.
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    return res.status(400).json({ error: 'Malformed JSON body' });
  }
  console.error('[error]', err);
  res.status(500).json({ error: 'Internal server error' });
}

export function notFoundHandler(req, res) {
  res.status(404).json({ error: `Route not found: ${req.method} ${req.path}` });
}
