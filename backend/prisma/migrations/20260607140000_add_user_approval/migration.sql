-- Self-registered users must be approved by an admin before they can upload.
-- New rows default to false; the register/admin-create code sets it explicitly.
ALTER TABLE "User" ADD COLUMN "approved" BOOLEAN NOT NULL DEFAULT false;

-- Backfill: every account that already exists keeps full access (don't lock out
-- current users when the gate is introduced).
UPDATE "User" SET "approved" = true;
