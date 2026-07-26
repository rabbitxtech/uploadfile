import { prisma } from '../config/prisma.js';

/**
 * Look up an account by the credential a user typed (username or email).
 *
 * Self-registration lowercases the address before storing it (registerSchema in
 * auth.routes.js), so "Bob@Example.com" is persisted as "bob@example.com". Every
 * lookup that matched the raw input therefore failed for anyone who typed their
 * address the way they registered it: register returned 201, and that very same
 * string then got 401 "Invalid credentials" at login, with only the all-lowercase
 * form working — which the user has no way to guess. forgot-password had it
 * worse, because it answers 200 either way (no enumeration), so recovery
 * silently did nothing.
 *
 * The exact value is tried FIRST so this stays purely additive: admin-created
 * accounts may use a plain username (users.routes.js does not lowercase, and its
 * IDENT_RE allows capitals), so "Bob" and a hypothetical "bob" remain distinct
 * rows and each still resolves to itself. Only when nothing matches exactly do
 * we fall back to the lowercased form, which is the shape self-registration
 * guarantees.
 *
 * Callers that must not disclose whether an account exists (login,
 * forgot-password, resend-verification) keep their own uniform responses — this
 * helper only decides which row is found, never what is said about it.
 */
export async function findUserByCredential(identifier) {
  if (typeof identifier !== 'string' || identifier === '') return null;
  const exact = await prisma.user.findUnique({ where: { email: identifier } });
  if (exact) return exact;
  const lowered = identifier.toLowerCase();
  if (lowered === identifier) return null;
  return prisma.user.findUnique({ where: { email: lowered } });
}
