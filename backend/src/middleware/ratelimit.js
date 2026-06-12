// B5 — rate limiting for sensitive endpoints. Behind nginx, `app.set('trust
// proxy', 1)` (in app.js) makes req.ip the real client IP via X-Forwarded-For.
import rateLimit from 'express-rate-limit';

const common = {
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
};

// Auth (login/register/forgot/reset): strict.
export const authLimiter = rateLimit({
  ...common,
  windowMs: 15 * 60 * 1000,
  limit: 20,
});

// Public share endpoints (view/download/upload via token): moderate per IP.
export const publicLimiter = rateLimit({
  ...common,
  windowMs: 15 * 60 * 1000,
  limit: 100,
});

// Anonymous drop-box uploads: strict per IP (Task 15 — anti-abuse). Tighter than
// publicLimiter because each request writes a file into the owner's storage.
export const uploadLimiter = rateLimit({
  ...common,
  windowMs: 15 * 60 * 1000,
  limit: 20,
  message: { error: 'Too many uploads from this address, please try again later.' },
});
