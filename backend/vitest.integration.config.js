// Integration suite — needs a real PostgreSQL (TEST_DATABASE_URL).
// Kept separate from vitest.config.js so `npm test` stays runnable with no
// database, which is what CI's fast path and most local edits rely on.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./test/setup.js'],
    include: ['test/integration/**/*.test.js'],
    // These share one database, so they must not run concurrently: resetDb()
    // truncates every table between tests.
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 30_000,
    hookTimeout: 120_000, // first run applies the whole migration history
  },
});
