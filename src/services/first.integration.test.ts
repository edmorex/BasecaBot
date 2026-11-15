import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { Storage } from './storage/index.js';
import { FirstService, pointsForPlace, TOP_N } from './first.js';

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
    first.setActiveStream(null); // reset overlay pointer between tests
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

  describe('currentRace (overlay snapshot)', () => {
    it('returns the ACTIVE race, ordered by place, with names + avatars', async () => {
      const a = await mkUser(1);
      const b = await mkUser(2);
      await prisma.user.update({ where: { id: a }, data: { avatarUrl: 'https://cdn/a.png' } });

      // A prior race (s1) is present but not active; only the active race shows.
      await first.checkIn(await mkUser(9), 's1', 3);
      await first.checkIn(a, 's2', 5); // place 1 in s2
      await first.checkIn(b, 's2', 11); // place 2 in s2

      first.setActiveStream('s2');
      const snap = await first.currentRace();
      expect(snap.streamKey).toBe('s2');
      expect(snap.entries).toEqual([
        { place: 1, name: 'First1', avatarUrl: 'https://cdn/a.png', timeSeconds: 5 },
        { place: 2, name: 'First2', avatarUrl: null, timeSeconds: 11 },
      ]);
    });

    it('is empty when no race is active (stream offline) and caps at the top 10', async () => {
      // No active stream set → empty, even though check-ins exist.
      for (let i = 1; i <= 12; i++) await first.checkIn(await mkUser(i), 'sBig', i);
      expect(await first.currentRace()).toEqual({ streamKey: null, entries: [] });

      first.setActiveStream('sBig');
      const snap = await first.currentRace();
      expect(snap.entries).toHaveLength(10);
      expect(snap.entries[0]!.place).toBe(1);
      expect(snap.entries[9]!.place).toBe(10);

      // Going "offline" clears the snapshot again.
      first.setActiveStream(null);
      expect((await first.currentRace()).entries).toEqual([]);
    });
  });

  /**
   * `!last` fills the board from the bottom end while `!first` fills it from the
   * top, so the two have to agree about which places are free. The hazard is the
   * old `COUNT(*) + 1`: after one !last there is one row, so the next !first would
   * have been handed place 2 with place 1 standing empty forever.
   */
  describe('!last', () => {
    /** The places held this stream, lowest first. */
    const board = async (streamKey: string) =>
      (await prisma.firstCheckin.findMany({ where: { streamKey }, orderBy: { place: 'asc' }, select: { place: true } }))
        .map((r) => r.place);

    it('takes 10th, then 9th, then 8th', async () => {
      const s = 'last.down';
      expect(await first.claimLast(await mkUser(1), s, 3)).toEqual({ outcome: 'claimed', place: 10, timeSeconds: 3, points: 1 });
      expect(await first.claimLast(await mkUser(2), s, 4)).toEqual({ outcome: 'claimed', place: 9, timeSeconds: 4, points: 2 });
      expect(await first.claimLast(await mkUser(3), s, 5)).toEqual({ outcome: 'claimed', place: 8, timeSeconds: 5, points: 3 });
      expect(await board(s)).toEqual([8, 9, 10]);
    });

    it('still gives the next !first place 1, not place 2', async () => {
      // THE regression this feature could have introduced.
      const s = 'last.thenfirst';
      await first.claimLast(await mkUser(1), s, 3);
      expect(await first.checkIn(await mkUser(2), s, 9)).toMatchObject({ place: 1, points: 10 });
      expect(await first.checkIn(await mkUser(3), s, 10)).toMatchObject({ place: 2 });
      expect(await board(s)).toEqual([1, 2, 10]);
    });

    it('meets !first in the middle and then does nothing', async () => {
      const s = 'last.meet';
      // Five from the top, five from the bottom: the board fills exactly.
      for (let i = 1; i <= 5; i++) expect(await first.checkIn(await mkUser(i), s, i)).toMatchObject({ place: i });
      for (let i = 0; i < 5; i++) {
        expect(await first.claimLast(await mkUser(20 + i), s, i)).toMatchObject({ place: 10 - i });
      }
      expect(await board(s)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

      // Nothing left to claim.
      expect(await first.claimLast(await mkUser(90), s, 99)).toEqual({ outcome: 'full' });
      expect(await board(s)).toHaveLength(TOP_N);
    });

    it('leaves !first free to overflow past the board once it is full', async () => {
      const s = 'last.overflow';
      for (let i = 0; i < TOP_N; i++) await first.claimLast(await mkUser(i), s, i);
      expect(await board(s)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      // 11th and 12th are still recorded, unscored, exactly as before.
      expect(await first.checkIn(await mkUser(50), s, 60)).toMatchObject({ place: 11, points: 0 });
      expect(await first.checkIn(await mkUser(51), s, 61)).toMatchObject({ place: 12, points: 0 });
      expect(await prisma.firstStat.findUnique({ where: { userId: `${P}50` } })).toBeNull();
    });

    it('fills a hole left in the middle, from whichever end asked', async () => {
      // Places are not always a tidy prefix and suffix — deleting an account frees
      // its place. Both commands have to see the gap rather than collide with a
      // place that is still held.
      const s = 'last.hole';
      for (let i = 1; i <= 5; i++) await first.checkIn(await mkUser(i), s, i);
      await prisma.firstCheckin.delete({ where: { streamKey_userId: { streamKey: s, userId: `${P}3` } } });
      expect(await board(s)).toEqual([1, 2, 4, 5]);

      expect(await first.checkIn(await mkUser(30), s, 30)).toMatchObject({ place: 3 });
      expect(await board(s)).toEqual([1, 2, 3, 4, 5]);
      expect(await first.claimLast(await mkUser(31), s, 31)).toMatchObject({ place: 10 });
    });

    describe('mixing the two commands', () => {
      it('refuses a !last from someone who already used !first', async () => {
        const s = 'mix.first-then-last';
        const u = await mkUser(1);
        expect(await first.checkIn(u, s, 2)).toMatchObject({ place: 1 });
        expect(await first.claimLast(u, s, 40)).toEqual({ outcome: 'repeat' });
        expect(await board(s)).toEqual([1]); // no second place taken
      });

      it('refuses a !first from someone who already used !last', async () => {
        const s = 'mix.last-then-first';
        const u = await mkUser(1);
        expect(await first.claimLast(u, s, 2)).toMatchObject({ place: 10 });
        expect(await first.checkIn(u, s, 40)).toEqual({ repeat: true });
        expect(await board(s)).toEqual([10]);
      });

      it('scores a claim once, whichever command made it', async () => {
        const s = 'mix.stats';
        const u = await mkUser(1);
        await first.claimLast(u, s, 7);                 // place 10 -> 1 point
        await first.claimLast(u, s, 7);                 // repeat, must not score again
        await first.checkIn(u, s, 7);                   // repeat, must not score again
        const stat = await prisma.firstStat.findUnique({ where: { userId: u } });
        expect(stat).toMatchObject({ firsts: 0, topTens: 1, sumPlace: 10, points: 1 });
      });

      it('counts a 10th taken with !last as a top-10 finish', async () => {
        const s = 'mix.toptens';
        const u = await mkUser(1);
        await first.claimLast(u, s, 4);
        // Same shape as reaching 10th the long way round: one top-10, no firsts.
        expect(await prisma.firstStat.findUnique({ where: { userId: u } })).toMatchObject({
          firsts: 0, topTens: 1, sumPlace: 10, sumTimeSeconds: 4, points: pointsForPlace(10),
        });
      });

      it('gives simultaneous !lasts different places', async () => {
        // Place assignment is one atomic statement, so a dead heat cannot hand two
        // people the same place or lose one of them.
        const s = 'mix.race';
        const users = await Promise.all([1, 2, 3, 4].map((n) => mkUser(n)));
        await Promise.all(users.map((u, i) => first.claimLast(u, s, i)));
        expect(await board(s)).toEqual([7, 8, 9, 10]);
      });

      it('gives a simultaneous !first and !last opposite ends', async () => {
        const s = 'mix.race2';
        const a = await mkUser(1);
        const b = await mkUser(2);
        await Promise.all([first.checkIn(a, s, 1), first.claimLast(b, s, 1)]);
        expect(await board(s)).toEqual([1, 10]);
      });

      it('shows both kinds of claim on the live board', async () => {
        const s = 'mix.overlay';
        await first.checkIn(await mkUser(1), s, 1);
        await first.claimLast(await mkUser(2), s, 2);
        first.setActiveStream(s);
        const snap = await first.currentRace();
        expect(snap.entries.map((e) => e.place)).toEqual([1, 10]);
      });
    });
  });
});
