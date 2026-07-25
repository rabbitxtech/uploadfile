import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./test/setup.js'],
    include: ['test/**/*.test.js'],
    // test/integration/** needs a real PostgreSQL and runs via
    // `npm run test:integration` (vitest.integration.config.js). Excluding it
    // here keeps `npm test` runnable with no database.
    exclude: ['**/node_modules/**', 'test/integration/**'],
  },
});
