// App-level invariants that are easy to break by reordering middleware and that
// no unit test covers, because each one is a property of how app.js is wired
// rather than of any single module. All of these are documented as "don't
// reorder" rules in .claude/CLAUDE.md; this file makes them fail loudly.
//
// These use buildApp() and never touch the database: every request here is
// rejected (401/404/405) before a route handler would query Prisma.
//
// That constraint is why there is no "unknown API key" case here — an API key
// has to be looked up to be rejected, so it needs a real database and belongs
// in a suite with one. Anything added here must fail before the first query.
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { buildApp } from '../src/app.js';

const app = buildApp();

describe('auth boundary', () => {
  // A route silently losing requireAuth is the highest-impact regression in the
  // app, and it looks like a passing test suite. Anonymous access must 401.
  const protectedRoutes = [
    ['get', '/api/folders'],
    ['get', '/api/files/recent'],
    ['get', '/api/files/starred'],
    ['get', '/api/files/search'],
    ['get', '/api/trash'],
    ['get', '/api/collections'],
    ['get', '/api/notifications'],
    ['get', '/api/keys'],
    ['get', '/api/grants/shared-with-me'],
    ['get', '/api/groups'],
    ['get', '/api/auth/sessions'],
    ['get', '/api/auth/me'],
    ['post', '/api/upload/init'],
  ];

  for (const [method, path] of protectedRoutes) {
    it(`${method.toUpperCase()} ${path} rejects an anonymous request`, async () => {
      const res = await request(app)[method](path);
      expect(res.status).toBe(401);
    });
  }

  it('rejects a malformed bearer token rather than treating it as anonymous', async () => {
    const res = await request(app)
      .get('/api/folders')
      .set('Authorization', 'Bearer not-a-real-jwt');
    expect(res.status).toBe(401);
  });

  it('rejects a bearer token signed with the wrong secret', async () => {
    // Structurally valid JWT, wrong signature — must fail signature
    // verification before any database lookup happens.
    const forged = [
      Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'),
      Buffer.from(JSON.stringify({ sub: 'u1', sid: 's1' })).toString('base64url'),
      'not-a-valid-signature',
    ].join('.');
    const res = await request(app).get('/api/folders').set('Authorization', `Bearer ${forged}`);
    expect(res.status).toBe(401);
  });

  it('admin-only routes are not reachable anonymously', async () => {
    // 401 (not 403): the auth gate must run before the role check, so an
    // anonymous caller never learns whether the route exists for admins.
    const res = await request(app).get('/api/audit');
    expect(res.status).toBe(401);
  });
});

describe('public routes stay public', () => {
  // These mount BEFORE router.use(requireAuth). If someone moves the auth mount
  // up, they start 401ing and public sharing / video playback breaks.
  // NOTE: this one reaches a Prisma query (to look the token up) and so spends
  // several seconds failing to connect before responding. That is fine for the
  // assertion — we only care that the request was NOT turned away by the auth
  // mount — but it is why this suite has just one such case.
  it('a public share link is readable without a session', async () => {
    const res = await request(app).get('/api/shares/public/some-token');
    expect(res.status).not.toBe(401);
  }, 20_000);

  it('the VAPID public key is served without a session', async () => {
    const res = await request(app).get('/api/push/vapid-public-key');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('enabled');
  });

  it('the video stream route is not behind the bearer-auth mount', async () => {
    // Browsers cannot set Authorization on <video src>, so this route
    // authenticates via the stream_tkn cookie instead. With no cookie it must
    // fail its own check (401/403/404) — never a route-level 401 from
    // requireAuth, which would mean it moved below the auth mount.
    const res = await request(app).get('/api/files/some-id/stream');
    expect([401, 403, 404]).toContain(res.status);
  });
});

describe('WebDAV mounts before cors()', () => {
  // cors() answers OPTIONS preflights itself and strips the DAV header, which
  // breaks client discovery. WebDAV is mounted above it on purpose.
  it('OPTIONS /webdav keeps the DAV capability header', async () => {
    const res = await request(app).options('/webdav');
    expect(res.headers.dav).toBeDefined();
  });

  it('unauthenticated WebDAV asks for Basic credentials', async () => {
    const res = await request(app).get('/webdav/');
    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toMatch(/Basic/i);
  });
});

// The 2FA tmpToken and the video stream token are signed with the SAME secret as
// a session token, so they clear jwt.verify and only a claim check separates
// them. authenticateWs rejects any token carrying a `p` claim; requireAuth must
// apply the same rule, or the REST API is weaker than the sockets. Neither token
// carries a `sid` today, so the session check would also catch them — these
// cases exist so that stays true by rule rather than by coincidence, and they
// fail before any database query (rejected on the claim, never looked up).
describe('purpose-scoped tokens are not session credentials', () => {
  const secret = process.env.JWT_SECRET;

  const purposeTokens = [
    ['a 2FA tmpToken (minted before the code is checked)', { sub: 'u1', p: '2fa' }],
    ['a video stream token', { sub: 'u1', fid: 'f1', p: 'stream' }],
    // A `p` token that also carries a sid must still be refused: the claim is
    // what disqualifies it, independently of session binding.
    ['a purpose token carrying a sid', { sub: 'u1', sid: 's1', p: 'stream' }],
  ];

  for (const [label, claims] of purposeTokens) {
    it(`rejects ${label} on an authenticated API route`, async () => {
      const token = jwt.sign(claims, secret, { expiresIn: '5m' });
      const res = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(401);
    });
  }
});

describe('security headers', () => {
  it('sets a CSP that allows Swagger UI inline scripts', async () => {
    const res = await request(app).get('/health');
    const csp = res.headers['content-security-policy'];
    expect(csp).toBeDefined();
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("object-src 'none'");
    // Dev is served over plain HTTP; upgrading insecure requests would break it.
    expect(csp).not.toContain('upgrade-insecure-requests');
  });

  it('does not leak the framework fingerprint', async () => {
    const res = await request(app).get('/health');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('sets nosniff', async () => {
    const res = await request(app).get('/health');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });
});

describe('error handling', () => {
  it('returns JSON, not an HTML error page, for an unknown API route', async () => {
    const res = await request(app).get('/api/definitely-not-a-route');
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/json/);
  });

  it('rejects malformed JSON with 400 rather than crashing', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .set('Content-Type', 'application/json')
      .send('{"identifier": broken');
    expect(res.status).toBe(400);
  });
});
