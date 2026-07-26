import { describe, it, expect } from 'vitest';
import { parseMentions, mentionWhere, MAX_MENTIONS } from '../src/utils/mentions.js';

describe('parseMentions', () => {
  it('returns nothing for an empty or non-string body', () => {
    expect(parseMentions('')).toEqual([]);
    expect(parseMentions(undefined)).toEqual([]);
    expect(parseMentions(null)).toEqual([]);
    expect(parseMentions('no mentions here')).toEqual([]);
  });

  it('picks up a plain mention', () => {
    expect(parseMentions('@alice hello')).toEqual(['alice']);
    expect(parseMentions('hey @bob, look')).toEqual(['bob']);
  });

  it('allows dots, dashes and underscores in a name', () => {
    expect(parseMentions('@bob.smith and @carol-x and @dan_y')).toEqual([
      'bob.smith',
      'carol-x',
      'dan_y',
    ]);
  });

  it('de-duplicates repeated mentions', () => {
    expect(parseMentions('@alice @alice @alice')).toEqual(['alice']);
  });

  // The bug this module exists for: the token feeds a local-part lookup, so a
  // bare address in the body used to yield "example.com" — which then matched
  // every account at that domain and notified all of them.
  it('does not treat an email address in the body as a mention', () => {
    expect(parseMentions('ping alice@example.com about it')).toEqual([]);
    expect(parseMentions('mail me: x@y.z')).toEqual([]);
  });

  it('still finds a real mention alongside an email address', () => {
    expect(parseMentions('ping alice@example.com and @bob')).toEqual(['bob']);
  });

  // Every token becomes an OR branch, and all but the exact match are unindexed
  // prefix scans. A 2000-char body (the comment limit) holds ~350 tokens, so an
  // uncapped list let any commenter turn one POST into hundreds of table scans
  // and notify hundreds of accounts.
  it('caps how many mentions one comment can carry', () => {
    let body = '';
    for (let i = 0; body.length < 2000; i++) body += `@user${i} `;

    const parsed = parseMentions(body);

    expect(parsed).toHaveLength(MAX_MENTIONS);
    // Kept in order of first appearance, so the earliest mentions survive.
    expect(parsed[0]).toBe('user0');
    expect(mentionWhere(parsed).OR).toHaveLength(MAX_MENTIONS + 1);
  });

  it('leaves an ordinary number of mentions untouched', () => {
    expect(parseMentions('@a @b @c')).toEqual(['a', 'b', 'c']);
  });
});

describe('mentionWhere', () => {
  it('matches a username-style account exactly and an email by local part', () => {
    const where = mentionWhere(['alice']);
    expect(where.OR).toContainEqual({ email: { in: ['alice'] } });
    expect(where.OR).toContainEqual({ email: { startsWith: 'alice@' } });
  });

  it('anchors the local-part match with @ so it cannot match a longer name', () => {
    // Without the trailing '@', "@bob" would also match "bobby@example.com".
    const where = mentionWhere(['bob']);
    const prefixes = where.OR.filter((c) => c.email.startsWith).map((c) => c.email.startsWith);
    expect(prefixes).toEqual(['bob@']);
  });
});
