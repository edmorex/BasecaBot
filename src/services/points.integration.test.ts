import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { Storage } from './storage/index.js';
import { PointsService, InsufficientPointsError } from './points.js';

// This test needs a migrated SQLite DB. Create it with:
//   DATABASE_URL="file:./prisma/basecabot.db" npx prisma migrate dev
const DB_PATH = path.resolve('prisma/basecabot.db');
const hasDb = existsSync(DB_PATH);
const run = hasDb ? describe : describe.skip;

run('PointsService (integration)', () => {
  const CHANNEL = 'itest_channel';
  const USER_A = 'itest_user_a';
  const USER_B = 'itest_user_b';
  let prisma: PrismaClient;
  let points: PointsService;

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: `file:${DB_PATH}` } } });
    points = new PointsService(new Storage(prisma));
    for (const id of [USER_A, USER_B]) {
      await prisma.user.upsert({
        where: { id },
        create: { id, login: id, displayName: id },
        update: {},
      });
    }
  });

  afterAll(async () => {
    await prisma.pointsBalance.deleteMany({ where: { channel: CHANNEL } });
    await prisma.user.deleteMany({ where: { id: { in: [USER_A, USER_B] } } });
    await prisma.$disconnect();
  });

  it('awards and reads a balance', async () => {
    await points.award(USER_A, CHANNEL, 100);
    expect(await points.getBalance(USER_A, CHANNEL)).toBe(100);
  });

  it('floors negative balances at zero', async () => {
    await points.award(USER_A, CHANNEL, -1000);
    expect(await points.getBalance(USER_A, CHANNEL)).toBe(0);
  });

  it('handles concurrent awards without lost updates', async () => {
    await points.award(USER_A, CHANNEL, -1_000_000); // reset to 0
    await Promise.all(Array.from({ length: 50 }, () => points.award(USER_A, CHANNEL, 2)));
    expect(await points.getBalance(USER_A, CHANNEL)).toBe(100);
  });

  it('rejects overspending', async () => {
    await expect(points.spend(USER_B, CHANNEL, 5)).rejects.toBeInstanceOf(InsufficientPointsError);
  });

  it('awardCapped stops at the cap and never reduces an over-cap balance', async () => {
    await points.award(USER_A, CHANNEL, -1_000_000); // reset to 0
    // Accrue toward the cap.
    await points.awardCapped(USER_A, CHANNEL, 25, 3000);
    expect(await points.getBalance(USER_A, CHANNEL)).toBe(25);
    // Near the cap: only rises to the cap, not past it.
    await points.award(USER_A, CHANNEL, 2975); // now 3000
    await points.awardCapped(USER_A, CHANNEL, 25, 3000);
    expect(await points.getBalance(USER_A, CHANNEL)).toBe(3000);
    // Already above the cap (e.g. via a gift): capped award leaves it untouched.
    await points.award(USER_A, CHANNEL, 500); // 3500
    await points.awardCapped(USER_A, CHANNEL, 25, 3000);
    expect(await points.getBalance(USER_A, CHANNEL)).toBe(3500);
  });

  it('transfers atomically', async () => {
    await points.award(USER_A, CHANNEL, -1_000_000); // reset A to 0
    await points.award(USER_A, CHANNEL, 30);
    await points.transfer(USER_A, USER_B, CHANNEL, 10);
    expect(await points.getBalance(USER_A, CHANNEL)).toBe(20);
    expect(await points.getBalance(USER_B, CHANNEL)).toBe(10);
  });
});
