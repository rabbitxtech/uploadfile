// Helpers for the integration suite (test/integration/**), which talks to a
// REAL PostgreSQL. Unit tests must not import this file — `npm test` has to keep
// running with no database, which is why the two suites are separate commands.
//
// Point TEST_DATABASE_URL at a throwaway database. The suite TRUNCATEs every
// table between tests, so never aim it at a database you care about; the guard
// below refuses the obvious production-looking names.
import { execSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';

const url = process.env.TEST_DATABASE_URL;

if (!url) {
  throw new Error(
    'TEST_DATABASE_URL is not set. Start one with:\n' +
      '  docker run --rm -d -p 55432:5432 -e POSTGRES_PASSWORD=test \\\n' +
      '    -e POSTGRES_USER=test -e POSTGRES_DB=test --name uploader-test-db \\\n' +
      '    pgvector/pgvector:pg16\n' +
      'then: TEST_DATABASE_URL=postgresql://test:test@localhost:55432/test npm run test:integration',
  );
}

// This suite wipes tables. Make it hard to point at the wrong database.
if (/\b(prod|production|live)\b/i.test(url)) {
  throw new Error(`TEST_DATABASE_URL looks like a production database, refusing: ${url}`);
}

process.env.DATABASE_URL = url;

export const prisma = new PrismaClient({ datasources: { db: { url } } });

/** Applies the migration history to the (empty) test database. */
export function migrateTestDb() {
  execSync('npx prisma migrate deploy', {
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'pipe',
  });
}

// Ordered so that a plain DELETE would satisfy FKs; TRUNCATE ... CASCADE makes
// the order irrelevant, but keeping the list explicit means a newly added model
// shows up here as a compile-time-ish reminder rather than a leaking table.
const TABLES = [
  'ShareAccess', 'Share', 'FileGrant', 'FolderGrant', 'Comment',
  'WatchProgress', 'FileVersion', 'UploadSession', 'Notification',
  'AuditLog', 'ApiKey', 'Token', 'Session', 'PushSubscription',
  'GroupMember', 'Group', 'Collection', 'File', 'Folder', 'Tag', 'User',
];

/** Wipes every table. Called between tests so each one starts from empty. */
export async function resetDb() {
  const list = TABLES.map((t) => `"${t}"`).join(', ');
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
}

export async function disconnect() {
  await prisma.$disconnect();
}
