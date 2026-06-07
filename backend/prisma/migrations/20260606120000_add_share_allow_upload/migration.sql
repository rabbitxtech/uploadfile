-- I1: folder upload-request links. Adds a flag marking a folder Share as one
-- that anonymous visitors may upload into.
ALTER TABLE "Share" ADD COLUMN "allowUpload" BOOLEAN NOT NULL DEFAULT false;
