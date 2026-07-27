// A 2FA recovery code is single-use, and "single" has to survive concurrency.
//
// consumeRecoveryCode() read the user's code list, checked membership, then
// wrote the filtered list back — a read-modify-write with nothing gating the
// write on what was read. Two requests presenting the SAME code at the same
// instant both read a list containing it, both match, and both write back a
// list missing it. Each one returns true, so one recovery code logs in twice.
//
// That matters because a recovery code is a full second-factor bypass: it is
// what someone uses when they have lost their authenticator, and it is the
// credential most likely to be captured in bulk (they are handed over as a
// printable block, get pasted into notes, screenshots and password managers).
// Single-use is the entire reason there are eight of them and they are stored
// hashed; a code that can be replayed concurrently is a code that has not
// actually been spent.
//
// Needs a real database: the fix is a conditional write, so the behaviour lives
// in what the DB does when two updates race, not in the JS.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';

const { prisma, migrateTestDb, resetDb, disconnect } = await import('../helpers/db.js');
const { makeUser } = await import('../helpers/fixtures.js');
const { generateRecoveryCodes, consumeRecoveryCode, verifySecondFactor } = await import(
  '../../src/services/totp.service.js'
);

beforeAll(() => {
  migrateTestDb();
}, 120_000);

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await disconnect();
});

async function userWithCodes() {
  const u = await makeUser();
  const { raw, hashes } = generateRecoveryCodes();
  const user = await prisma.user.update({
    where: { id: u.id },
    data: { totpEnabled: true, totpSecret: 'JBSWY3DPEHPK3PXP', recoveryCodes: JSON.stringify(hashes) },
  });
  return { user, raw };
}

const remaining = async (id) => {
  const u = await prisma.user.findUnique({ where: { id } });
  return JSON.parse(u.recoveryCodes || '[]').length;
};

describe('recovery codes are single-use', () => {
  it('accepts a code once and rejects the same code afterwards', async () => {
    const { user, raw } = await userWithCodes();

    expect(await consumeRecoveryCode(user, raw[0])).toBe(true);
    const fresh = await prisma.user.findUnique({ where: { id: user.id } });
    expect(await consumeRecoveryCode(fresh, raw[0])).toBe(false);
    expect(await remaining(user.id)).toBe(7);
  });

  // The race: both callers hold the user row as they read it, which is exactly
  // what two concurrent /2fa/verify requests do.
  it('accepts a code only ONCE when two requests present it at the same time', async () => {
    const { user, raw } = await userWithCodes();

    const [a, b] = await Promise.all([
      consumeRecoveryCode(user, raw[0]),
      consumeRecoveryCode(user, raw[0]),
    ]);

    // Exactly one of the two may succeed.
    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect(await remaining(user.id)).toBe(7);
  });

  // Two DIFFERENT codes racing must both succeed and both be spent — the fix
  // must not serialize into "one write wins and the other's code silently
  // survives", which would leave a used code live.
  it('spends both codes when two different ones are used at the same time', async () => {
    const { user, raw } = await userWithCodes();

    const [a, b] = await Promise.all([
      consumeRecoveryCode(user, raw[0]),
      consumeRecoveryCode(user, raw[1]),
    ]);

    expect(a).toBe(true);
    expect(b).toBe(true);
    expect(await remaining(user.id)).toBe(6);
  });

  it('rejects a code that was never issued', async () => {
    const { user } = await userWithCodes();
    expect(await consumeRecoveryCode(user, 'aaaaa-bbbbb')).toBe(false);
    expect(await remaining(user.id)).toBe(8);
  });

  // verifySecondFactor is the login-path wrapper; the same guarantee has to
  // hold through it, since that is what /2fa/verify actually calls.
  it('holds through verifySecondFactor', async () => {
    const { user, raw } = await userWithCodes();

    const [a, b] = await Promise.all([
      verifySecondFactor(user, raw[2]),
      verifySecondFactor(user, raw[2]),
    ]);

    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect(await remaining(user.id)).toBe(7);
  });
});
