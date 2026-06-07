-- One-time backfill for the new email-verification gate.
-- Accounts that already existed before verification was introduced are trusted
-- (admin-created or first-admin), so mark them verified to avoid locking anyone
-- out. New self-registrations created after this migration start unverified.
UPDATE "User" SET "emailVerified" = true WHERE "emailVerified" = false;
