import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { verifyTotp, generateRecoveryCodes } from '../src/services/totp.service.js';

const require = createRequire(import.meta.url);
const { authenticator } = require('otplib');

describe('totp.service', () => {
  it('verifies a freshly generated code against its secret', () => {
    const secret = authenticator.generateSecret();
    const code = authenticator.generate(secret);
    expect(verifyTotp(secret, code)).toBe(true);
  });

  it('rejects wrong codes and missing inputs', () => {
    const secret = authenticator.generateSecret();
    expect(verifyTotp(secret, '000000')).toBe(false);
    expect(verifyTotp(secret, '')).toBe(false);
    expect(verifyTotp(null, '123456')).toBe(false);
    expect(verifyTotp(secret, 'not-a-code')).toBe(false);
  });

  it('generates 8 unique recovery codes with matching sha256 hashes', () => {
    const { raw, hashes } = generateRecoveryCodes();
    expect(raw).toHaveLength(8);
    expect(new Set(raw).size).toBe(8);
    expect(hashes).toHaveLength(8);
    for (const c of raw) expect(c).toMatch(/^[0-9a-f]{5}-[0-9a-f]{5}$/);
  });
});
