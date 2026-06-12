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
export async function consumeRecoveryCode(user, code) {
  if (!user.recoveryCodes || !code) return false;
  let hashes;
  try {
    hashes = JSON.parse(user.recoveryCodes);
  } catch {
    return false;
  }
  const h = sha256(String(code).trim().toLowerCase());
  if (!Array.isArray(hashes) || !hashes.includes(h)) return false;
  await prisma.user.update({
    where: { id: user.id },
    data: { recoveryCodes: JSON.stringify(hashes.filter((x) => x !== h)) },
  });
  return true;
}

// Login-time check: a 6-digit TOTP code or a recovery code (consumed).
export async function verifySecondFactor(user, code) {
  if (verifyTotp(user.totpSecret, code)) return true;
  return consumeRecoveryCode(user, code);
}
