// Which of a set of to-be-deleted folders are actually safe to delete.
//
// Folder.parent is `onDelete: Cascade`, so a deleteMany on folder rows is never
// just the rows it matched — it silently takes each matched folder's entire
// subtree with it. Files under a cascaded folder are not deleted (File.folder is
// SetNull) but are *relocated to the root*, which is harder to diagnose than an
// outright delete and leaves their bytes unrefunded, since no refund path ever
// saw those files.
//
// Trashing a folder stamps its whole subtree with one timestamp, so a subtree
// normally becomes deletable all at once. Restore is what breaks the assumption:
// it un-trashes only the exact ids it is handed, with no descendant walk. So a
// user can restore a child out of a long-trashed parent, and any bulk delete of
// "everything trashed" then destroys the folder they just chose to keep.
//
// Both bulk folder deletes (the retention sweep and POST /trash/empty) therefore
// filter through here: skip any candidate that still has a surviving descendant,
// and let it go on a later pass once that descendant is trashed or moved away.

/**
 * Filter `candidates` down to the folders with no surviving descendant.
 *
 * @param candidates  [{ id, ownerId, path }] — the folders slated for deletion
 * @param survivors   [{ ownerId, path }] — folders that must NOT be destroyed
 * @returns string[]  ids safe to pass to deleteMany
 *
 * Comparison is grouped per owner because `Folder.path` is denormalised from
 * folder NAMES only and is not namespaced — two users can each own "/docs", and
 * a stranger's identically-named folder must not block (or trigger) a purge.
 */
export function deletableFolderIds(candidates, survivors) {
  const survivorsByOwner = new Map();
  for (const s of survivors) {
    if (!survivorsByOwner.has(s.ownerId)) survivorsByOwner.set(s.ownerId, []);
    survivorsByOwner.get(s.ownerId).push(s.path);
  }

  return candidates
    .filter((f) => {
      const prefix = f.path === '/' ? '/' : f.path + '/';
      const paths = survivorsByOwner.get(f.ownerId) || [];
      // startsWith(prefix) is a strict-descendant test: the prefix carries a
      // trailing slash, so a survivor at the candidate's own path does not match
      // (that would be the candidate itself, or a same-named folder already
      // covered by the owner grouping), while "/docs/2025" under "/docs/" does.
      return !paths.some((p) => p.startsWith(prefix));
    })
    .map((f) => f.id);
}
