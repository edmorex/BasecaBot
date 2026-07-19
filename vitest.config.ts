import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Prepare an isolated, migrated prisma/test.db before the integration tests
    // run, so they never touch the real dev database.
    globalSetup: ['./test/globalSetup.ts'],
    // Run test FILES one at a time. Every integration suite shares that single
    // prisma/test.db, and several reset a whole table in beforeEach — in
    // parallel, one file's wipe lands in the middle of another's assertions
    // (e.g. quotes.integration clearing Quote while users.integration counts
    // quotes per user). Serializing costs ~a second and makes the shared-DB
    // suites deterministic. Tests WITHIN a file still run as usual.
    fileParallelism: false,
  },
});
