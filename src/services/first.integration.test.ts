import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { Storage } from './storage/index.js';
import { FirstService, pointsForPlace } from './first.js';

// Runs against the isolated, migrated prisma/test.db (prepared by vitest global
// setup); skipped if that DB is absent.
const DB_PATH = path.resolve('prisma/test.db');
const hasDb = existsSync(DB_PATH);
const run = hasDb ? describe : describe.skip;

describe('pointsForPlace (unit)', () => {
  it('awards 10 down to 1 for places 1..10, and 0 beyond', () => {
    expect([1, 2, 3, 9, 10].map(pointsForPlace)).toEqual([10, 9, 8, 2, 1]);
    expect(pointsForPlace(11)).toBe(0);
    expect(pointsForPlace(100)).toBe(0);
    expect(pointsForPlace(0)).toBe(0);
  });
});

run('FirstService (integration)', () => {
  let prisma: PrismaClient;
  let first: FirstService;

  // Distinct users; ids are prefixed so cleanup is scoped.
  const P = 'itest_first_';
  const mkUser = async (n: number) => {
    const id = `${P}${n}`;
    await prisma.user.upsert({
      where: { id },
      create: { id, login: id, displayName: `First${n}` },
      update: { displayName: `First${n}` },
    });
    return id;
  };

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: `file:${DB_PATH}` } } });
    first = new FirstService(new Storage(prisma));
  });

  beforeEach(async () => {
    await prisma.firstCheckin.deleteMany({});
    await prisma.firstStat.deleteMany({});
    await prisma.user.deleteMany({ where: { id: { startsWith: P } } });
  });

  afterAll(async () => {
    await prisma.firstCheckin.deleteMany({});
    await prisma.firstStat.deleteMany({});
    await prisma.user.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.$disconnect();
  });

  it('assigns ascending places and matching points within one stream', async () => {
    const s = 'streamA';
    const a = await mkUser(1);
    const b = await mkUser(2);
    const c = await mkUser(3);

    expect(await first.checkIn(a, s, 5)).toEqual({ repeat: false, place: 1, timeSeconds: 5, points: 10 });
    expect(await first.checkIn(b, s, 8)).toEqual({ repeat: false, place: 2, timeSeconds: 8, points: 9 });
    expect(await first.checkIn(c, s, 12)).toEqual({ repeat: false, place: 3, timeSeconds: 12, points: 8 });
  });

  it('treats a second check-in the same stream as a repeat (no place change)', async () => {
    const s = 'streamB';
    const a = await mkUser(1);
    await first.checkIn(a, s, 5);
    expect(await first.checkIn(a, s, 99)).toEqual({ repeat: true });
    // The stat row still reflects only the first check-in.
    const stat = await prisma.firstStat.findUnique({ where: { userId: a } });
    expect(stat).toMatchObject({ firsts: 1, topTens: 1, sumTimeSeconds: 5, points: 10 });
  });

  it('lets the same user race again in a different stream', async () => {
    const a = await mkUser(1);
    expect((await first.checkIn(a, 's1', 5)).repeat).toBe(false);
    const r2 = await first.checkIn(a, 's2', 7);
    expect(r2).toEqual({ repeat: false, place: 1, timeSeconds: 7, points: 10 });
    const stat = await prisma.firstStat.findUnique({ where: { userId: a } });
    expect(stat).toMatchObject({ firsts: 2, topTens: 2, sumTimeSeconds: 12, sumPlace: 2, points: 20 });
  });

  it('records 11th+ check-ins but does not touch cumulative stats', async () => {
    const s = 'streamC';
    for (let i = 1; i <= 10; i++) await first.checkIn(await mkUser(i), s, i);
    const late = await mkUser(11);
    const r = await first.checkIn(late, s, 100);
    expect(r).toEqual({ repeat: false, place: 11, timeSeconds: 100, points: 0 });
    expect(await prisma.firstStat.findUnique({ where: { userId: late } })).toBeNull();
  });

  it('averages only over top-10 finishes, via running sums', async () => {
    const a = await mkUser(1);
    await first.checkIn(a, 's1', 10); // place 1
    // place 2 in the next stream: seed a leader first
    await first.checkIn(await mkUser(99), 's2', 1);
    await first.checkIn(a, 's2', 30); // place 2
    const s = await first.statsFor(a);
    expect(s).not.toBeNull();
    expect(s!.topTens).toBe(2);
    expect(s!.avgTime).toBeCloseTo(20); // (10 + 30) / 2
    expect(s!.avgPlace).toBeCloseTo(1.5); // (1 + 2) / 2
  });

  it('builds leaderboards and ranks players', async () => {
    const winner = await mkUser(1); // 2 firsts
    const runnerUp = await mkUser(2); // 1 first
    await first.checkIn(winner, 's1', 5);
    await first.checkIn(winner, 's2', 6);
    await first.checkIn(runnerUp, 's1', 9); // place 2
    await first.checkIn(runnerUp, 's2', 8); // place 2
    await first.checkIn(runnerUp, 's3', 20); // place 1

    const firsts = await first.topFirsts();
    expect(firsts.map((r) => r.displayName)).toEqual(['First1', 'First2']);
    expect(firsts[0]!.value).toBe(2);

    const time = await first.topTime();
    // winner avg (5+6)/2=5.5 beats runnerUp
    expect(time[0]!.displayName).toBe('First1');

    const wr = await first.statsFor(winner);
    expect(wr!.ranks.firsts).toBe(1);
    expect(wr!.ranks.avgTime).toBe(1);
    const rr = await first.statsFor(runnerUp);
    expect(rr!.ranks.firsts).toBe(2);
  });

  it('returns null stats for a user who never placed', async () => {
    const ghost = await mkUser(1);
    expect(await first.statsFor(ghost)).toBeNull();
  });
});
