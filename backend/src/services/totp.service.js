// Task5 #1 — TOTP two-factor auth helpers (otplib + qrcode).
// The secret is stored on the User row at setup time but 2FA is only enforced
// once `totpEnabled` is true (set after the user proves they can generate a
// valid code). Recovery codes are random, shown once, stored as sha256 hashes
// (JSON array) and consumed on use.
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import QRCode from 'qrcode';
import { prisma } from '../config/prisma.js';

// otplib v12 is CJS with re-exported names that Node's ESM named-export
// detection misses — `import { authenticator }` arrives undefined. require()
// through createRequire gets the real object.
const require = createRequire(import.meta.url);
const { authenticator } = require('otplib');

const ISSUER = 'Uploader';
const RECOVERY_COUNT = 8;

// Accept the previous/next 30s step too — phone clocks drift.
authenticator.options = { window: 1 };

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

// Generate a fresh secret + provisioning QR for the setup screen.
export async function generateSetup(user) {
  const secret = authenticator.generateSecret();
  const otpauth = authenticator.keyuri(user.email, ISSUER, secret);
  const qr = await QRCode.toDataURL(otpauth, { margin: 1, width: 220 });
  return { secret, otpauth, qr };
}

export function verifyTotp(secret, code) {
  if (!secret || !code) return false;
  try {
    return authenticator.verify({ token: String(code).replace(/\s+/g, ''), secret });
  } catch {
    return false;
  }
}

// Create the one-time recovery codes; returns { raw, hashes }. Format
// "xxxxx-xxxxx" so they're visually distinct from 6-digit TOTP codes.
export function generateRecoveryCodes() {
  const raw = Array.from({ length: RECOVERY_COUNT }, () => {
    const h = crypto.randomBytes(5).toString('hex');
    return `${h.slice(0, 5)}-${h.slice(5)}`;
  });
  return { raw, hashes: raw.map(sha256) };
}

// Try `code` against the user's unused recovery codes; consumes it on match.
//
// The consume is a compare-and-set, not a read-modify-write. `recoveryCodes` is
// a JSON *string* column, so it can only be rewritten wholesale, and a plain
// read-then-write breaks in both directions when two requests land together:
//
//   - The SAME code twice: both read a list containing it, both match, both
//     write back a list without it, and both return true. One recovery code
//     logs in twice — and a recovery code is a full second-factor bypass, the
//     credential most likely to leak in bulk (they are handed over as a
//     printable block that gets pasted into notes and password managers).
//     Single-use is the entire reason they are issued in eights and stored
//     hashed.
//   - TWO DIFFERENT codes at once: each writes back the list it read, so the
//     second write restores the code the first one just spent. A code that was
//     used successfully stays live.
//
// Gating the write on the exact string we based the new list on makes the
// update atomic, and re-reading on contention lets the loser retry against the
// list the winner actually wrote. Bounded, then fail closed: refusing a valid
// code under sustained contention is the safe direction — the user retries,
// whereas accepting one twice is the bypass this exists to prevent.
export async function consumeRecoveryCode(user, code) {
  if (!user.recoveryCodes || !code) return false;
  const h = sha256(String(code).trim().toLowerCase());

  let current = user.recoveryCodes;
  for (let attempt = 0; attempt < 5; attempt++) {
    let hashes;
    try {
      hashes = JSON.parse(current);
    } catch {
      return false;
    }
    // Re-checked on every attempt, against the list as it stands now: if a
    // racing request spent this same code first, it is gone from the list the
    // retry reads and this call correctly refuses.
    if (!Array.isArray(hashes) || !hashes.includes(h)) return false;

    const next = JSON.stringify(hashes.filter((x) => x !== h));
    const written = await prisma.user.updateMany({
      where: { id: user.id, recoveryCodes: current },
      data: { recoveryCodes: next },
    });
    if (written.count > 0) return true;

    const fresh = await prisma.user.findUnique({
      where: { id: user.id },
      select: { recoveryCodes: true },
    });
    if (!fresh?.recoveryCodes) return false;
    current = fresh.recoveryCodes;
  }
  return false;
}

// Login-time check: a 6-digit TOTP code or a recovery code (consumed).
export async function verifySecondFactor(user, code) {
  if (verifyTotp(user.totpSecret, code)) return true;
  return consumeRecoveryCode(user, code);
}
