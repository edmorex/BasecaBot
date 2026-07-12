import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Prepare an isolated, migrated prisma/test.db before the integration tests
    // run, so they never touch the real dev database.
    globalSetup: ['./test/globalSetup.ts'],
  },
});
