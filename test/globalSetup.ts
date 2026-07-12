import { execSync } from 'node:child_process';

/**
 * Vitest global setup: prepare an isolated, migrated SQLite database for the
 * integration tests (`prisma/test.db`) so they never read or mutate the real
 * dev database. Runs `prisma migrate deploy` against it once before the suite.
 *
 * If preparation fails (e.g. Prisma CLI unavailable), the integration tests
 * detect the missing DB via `existsSync` and skip, rather than failing the run.
 */
export default function setup(): void {
  try {
    execSync('npx prisma migrate deploy', {
      env: { ...process.env, DATABASE_URL: 'file:./test.db' }, // resolved relative to prisma/schema.prisma
      stdio: 'ignore',
    });
  } catch (err) {
    console.warn('[test] could not prepare prisma/test.db; integration tests will skip.', err);
  }
}
