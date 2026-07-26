import { describe, it, expect } from 'vitest';
import { deletableFolderIds } from '../src/utils/foldercascade.js';

const OWNER = 'owner-1';
const f = (id, path, ownerId = OWNER) => ({ id, ownerId, path });
const s = (path, ownerId = OWNER) => ({ ownerId, path });

describe('deletableFolderIds', () => {
  it('deletes a folder with no descendants at all', () => {
    expect(deletableFolderIds([f('a', '/docs')], [])).toEqual(['a']);
  });

  it('deletes a whole expired subtree together', () => {
    const candidates = [f('a', '/docs'), f('b', '/docs/2025'), f('c', '/docs/2025/q1')];
    expect(deletableFolderIds(candidates, [])).toEqual(['a', 'b', 'c']);
  });

  // The bug this module exists for: the cascade would take the restored child
  // with the parent, orphaning its files to the root and never refunding them.
  it('skips a folder that still has a live descendant', () => {
    const out = deletableFolderIds([f('a', '/docs')], [s('/docs/2025')]);
    expect(out).toEqual([]);
  });

  it('skips only the ancestor, still deleting unrelated siblings', () => {
    const candidates = [f('a', '/docs'), f('b', '/photos')];
    const out = deletableFolderIds(candidates, [s('/docs/2025')]);
    expect(out).toEqual(['b']);
  });

  it('skips a deep ancestor, not just the direct parent', () => {
    const candidates = [f('a', '/docs'), f('b', '/docs/2025')];
    const out = deletableFolderIds(candidates, [s('/docs/2025/q1')]);
    expect(out).toEqual([]);
  });

  // Folder.path is names-only and NOT namespaced per owner, so a stranger's
  // identically-named folder must neither block nor trigger a purge.
  it('compares paths only within one owner', () => {
    const out = deletableFolderIds([f('a', '/docs')], [s('/docs/2025', 'someone-else')]);
    expect(out).toEqual(['a']);
  });

  it('does not treat a survivor at the same path as a descendant', () => {
    // The prefix carries a trailing slash, so an exact-path match is not a
    // strict descendant — otherwise nothing would ever be deletable.
    expect(deletableFolderIds([f('a', '/docs')], [s('/docs')])).toEqual(['a']);
  });

  it('does not treat a name-prefix sibling as a descendant', () => {
    // "/docs-old" starts with "/docs" but is NOT under it; the trailing slash in
    // the prefix is what keeps this from blocking the delete.
    expect(deletableFolderIds([f('a', '/docs')], [s('/docs-old')])).toEqual(['a']);
  });

  it('handles a root candidate', () => {
    expect(deletableFolderIds([f('a', '/')], [s('/docs')])).toEqual([]);
    expect(deletableFolderIds([f('a', '/')], [])).toEqual(['a']);
  });

  it('returns nothing for no candidates', () => {
    expect(deletableFolderIds([], [s('/docs')])).toEqual([]);
  });
});
