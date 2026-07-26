// @mention extraction for comment bodies.
//
// Extracted from the comments route so the tokenising rules are unit-testable:
// the tokens are fed straight into a User lookup that matches an email's local
// part, so a mis-parsed token doesn't just miss a mention — it can match
// unrelated accounts and notify them.

/**
 * How many mentions one comment may notify.
 *
 * Each token becomes an OR branch in the user lookup, and all but the exact
 * match are unindexed `startsWith` prefix scans. A comment body is allowed
 * 2000 characters, which fits ~350 distinct tokens — so without a cap any user
 * who can comment can make every POST run hundreds of table scans, and notify
 * hundreds of accounts at once. The cap keeps that bounded; genuine comments
 * mention a handful of people.
 */
export const MAX_MENTIONS = 20;

/**
 * Pull the distinct @mention names out of a comment body.
 *
 * A mention is an "@" that starts a word, followed by username characters. The
 * leading (?<![A-Za-z0-9._-]) is what stops a plain address written in the body
 * ("mail alice@example.com") from yielding the token "example.com" — which the
 * local-part lookup would then resolve against every account at that domain.
 *
 * Truncated to MAX_MENTIONS (in order of first appearance) rather than
 * rejecting the comment: over-mentioning is not worth failing a post over, and
 * the earliest mentions are the ones the author most likely meant.
 */
export function parseMentions(body) {
  if (!body || typeof body !== 'string') return [];
  const matches = body.match(/(?<![A-Za-z0-9._-])@([a-zA-Z0-9._-]+)/g) || [];
  return [...new Set(matches.map((m) => m.slice(1)))].slice(0, MAX_MENTIONS);
}

/**
 * Prisma `where` matching the users a mention list refers to.
 *
 * The mention token can't contain "@" (that is what terminates it), so an exact
 * match on User.email only ever resolves username-style accounts. Since
 * self-registration requires a real email address, those users would be
 * unmentionable — hence also matching the email's local part, i.e. "@alice"
 * finds alice@example.com. Local parts are not unique, so every account sharing
 * one is matched; that is the intended read of an ambiguous mention, and
 * recipients are de-duplicated by the caller.
 */
export function mentionWhere(mentions) {
  return {
    OR: [
      { email: { in: mentions } },
      ...mentions.map((m) => ({ email: { startsWith: `${m}@` } })),
    ],
  };
}
