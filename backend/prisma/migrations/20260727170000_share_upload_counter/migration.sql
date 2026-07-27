-- Drop-box upload counter on Share.
--
-- The per-link upload cap (DROPBOX_MAX_UPLOADS_PER_SHARE) used to be enforced by
-- COUNTing ShareAccess rows with action='upload' and then writing one of those
-- rows after the file was created. That is a check-then-act with the whole
-- upload inside the window, on an endpoint that takes no authentication at all:
-- concurrent uploads all read the same count and all committed.
--
-- A counter on the row can be claimed in one conditional UPDATE, which the
-- database serialises — the same fix `downloads` and reserveQuota use.
ALTER TABLE "Share" ADD COLUMN "uploads" INTEGER NOT NULL DEFAULT 0;

-- Backfill from the access log so links that have already received uploads keep
-- the slots they have used, rather than silently getting their full cap back.
UPDATE "Share" s
SET "uploads" = sub.n
FROM (
  SELECT "shareId", COUNT(*)::int AS n
  FROM "ShareAccess"
  WHERE "action" = 'upload'
  GROUP BY "shareId"
) AS sub
WHERE s."id" = sub."shareId";
