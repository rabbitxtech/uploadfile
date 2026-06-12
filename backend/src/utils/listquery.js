// Task5 #20 — cursor pagination + server-side sort for folder listings.
// The client can no longer sort locally (it only ever sees a page), so the
// sort key/direction ride along with the cursor and map to Prisma orderBy.

export const LIST_TAKE_DEFAULT = 200;
export const LIST_TAKE_MAX = 500;

const FILE_SORT_FIELDS = {
  name: 'name',
  size: 'size',
  type: 'mimeType',
  modified: 'updatedAt',
};

// Folders have no meaningful size/type — those keys fall back to name,
// mirroring what the client-side sort used to do.
const FOLDER_SORT_FIELDS = {
  name: 'name',
  size: 'name',
  type: 'name',
  modified: 'updatedAt',
};

export function parseListQuery(query = {}) {
  const rawTake = Number.parseInt(query.take, 10);
  const take = Number.isFinite(rawTake)
    ? Math.min(Math.max(rawTake, 1), LIST_TAKE_MAX)
    : LIST_TAKE_DEFAULT;
  const cursor = typeof query.cursor === 'string' && query.cursor ? query.cursor : null;
  const sort = Object.hasOwn(FILE_SORT_FIELDS, query.sort) ? query.sort : 'name';
  const dir = query.dir === 'desc' ? 'desc' : 'asc';
  return { take, cursor, sort, dir };
}

// Stable order: the requested field plus an id tiebreaker, so a cursor page
// never skips/duplicates rows that share the same sort value.
export function fileOrderBy(sort, dir) {
  return [{ [FILE_SORT_FIELDS[sort] || 'name']: dir }, { id: 'asc' }];
}

export function folderOrderBy(sort, dir) {
  return [{ [FOLDER_SORT_FIELDS[sort] || 'name']: dir }, { id: 'asc' }];
}

// Prisma args for one page: fetch take+1 to learn whether a next page exists.
export function filePageArgs({ take, cursor }) {
  return {
    take: take + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  };
}

// Trim the probe row and derive the next cursor.
export function pageResult(rows, take) {
  const hasMore = rows.length > take;
  const files = hasMore ? rows.slice(0, take) : rows;
  return { files, nextCursor: hasMore ? files[files.length - 1].id : null };
}
