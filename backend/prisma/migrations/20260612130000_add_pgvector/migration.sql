-- Task5 #12 — pgvector for semantic search.
--
-- This migration assumes the database now runs on a pgvector-capable image
-- (docker-compose switched postgres:16-alpine -> pgvector/pgvector:pg16).
-- That image swap also moves libc from musl to glibc, which changes text
-- collation order — btree indexes on text columns built under musl may be
-- silently inconsistent under glibc. REINDEX every app table once to be safe
-- (instant on small tables, one-time cost on big ones). REINDEX TABLE is
-- allowed inside a transaction (only REINDEX DATABASE is not).
REINDEX TABLE "User";
REINDEX TABLE "Session";
REINDEX TABLE "AuditLog";
REINDEX TABLE "ApiKey";
REINDEX TABLE "Token";
REINDEX TABLE "Collection";
REINDEX TABLE "Folder";
REINDEX TABLE "File";
REINDEX TABLE "FileVersion";
REINDEX TABLE "Tag";
REINDEX TABLE "Share";
REINDEX TABLE "ShareAccess";
REINDEX TABLE "Notification";
REINDEX TABLE "Group";
REINDEX TABLE "GroupMember";
REINDEX TABLE "FileGrant";
REINDEX TABLE "FolderGrant";
REINDEX TABLE "Comment";
REINDEX TABLE "WatchProgress";
REINDEX TABLE "UploadSession";
REINDEX TABLE "_FileTags";
REINDEX TABLE "_CollectionFiles";

CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE "File" ADD COLUMN "embeddingVec" vector(384);

-- Backfill from the JSON-string embeddings: the JSON array text '[0.1,...]' is
-- exactly pgvector's input format. Only cast rows with the expected 384 dims
-- (383 commas) so a stray malformed/legacy row can't fail the migration.
UPDATE "File"
SET "embeddingVec" = "embedding"::vector
WHERE "embedding" IS NOT NULL
  AND length("embedding") - length(replace("embedding", ',', '')) = 383;

-- ANN index: cosine distance (embeddings are L2-normalized by the model).
CREATE INDEX "File_embeddingVec_idx" ON "File" USING hnsw ("embeddingVec" vector_cosine_ops);
