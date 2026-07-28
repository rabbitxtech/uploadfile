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
//
// A SURVIVING FILE COUNTS TOO, and for a while only surviving folders did.
// A live file directly inside a trashed folder is not deleted by the cascade —
// `File.folder` is SetNull — so the row survives, silently RELOCATED to the
// root. That is the outcome this module's header calls "harder to diagnose than
// an outright delete", reached without a single folder being involved:
//
//   1. The user trashes "/docs"; the stamp lands on the folder and its files.
//   2. They restore ONE file out of it. The Trash page lists trashed files and
//      trashed folders in two separate tables, so this is one click, and restore
//      un-trashes exactly the ids it is handed. The file is live; "/docs" is not.
//   3. The file half of both sweeps then deliberately SKIPS that file (it is not
//      trashed at all) — which is precisely what leaves it there to be orphaned
//      when the folder half deletes the folder out from under it.
//
// So the file guard and the folder guard are one rule, not two: the point of
// keeping the file is that it stays where the user put it. `folderHasLiveFile`
// is passed in rather than derived here so this module stays a pure function
// over rows the callers have already fetched (both of them need the same query
// for their own file half anyway).

/**
 * Filter `candidates` down to the folders with no surviving descendant.
 *
 * @param candidates  [{ id, ownerId, path }] — the folders slated for deletion
 * @param survivors   [{ ownerId, path }] — folders that must NOT be destroyed
 * @param liveFileFolderIds  Set<string> — ids of folders that still hold a file
 *                    which is NOT being deleted. Deleting such a folder would
 *                    orphan that file to the root (File.folder is SetNull).
 * @returns string[]  ids safe to pass to deleteMany
 *
 * Comparison is grouped per owner because `Folder.path` is denormalised from
 * folder NAMES only and is not namespaced — two users can each own "/docs", and
 * a stranger's identically-named folder must not block (or trigger) a purge.
 * `liveFileFolderIds` needs no such grouping: it holds folder IDs, which are
 * unique, so a stranger's identically-named folder can never appear in it.
 */
export function deletableFolderIds(candidates, survivors, liveFileFolderIds = new Set()) {
  const survivorsByOwner = new Map();
  for (const s of survivors) {
    if (!survivorsByOwner.has(s.ownerId)) survivorsByOwner.set(s.ownerId, []);
    survivorsByOwner.get(s.ownerId).push(s.path);
  }

  // A folder holding a live file must survive — and so must every ANCESTOR of
  // it, or the cascade reaches the file from further up. Adding those folders'
  // paths to the survivor list expresses exactly that: the existing strict-
  // descendant test then protects the whole chain above them, which is the same
  // work it already does for a surviving child folder.
  for (const f of candidates) {
    if (!liveFileFolderIds.has(f.id)) continue;
    if (!survivorsByOwner.has(f.ownerId)) survivorsByOwner.set(f.ownerId, []);
    survivorsByOwner.get(f.ownerId).push(f.path);
  }

  return candidates
    .filter((f) => {
      // Holds a file that is staying: deleting it would orphan that file.
      if (liveFileFolderIds.has(f.id)) return false;
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
