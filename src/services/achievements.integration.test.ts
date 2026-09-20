import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { Storage } from './storage/index.js';
import { EventBus } from '../core/eventBus.js';
import { AchievementService } from './achievements.js';
import { monthsSince } from './achievementCatalog.js';
import type { AppConfig } from './config.js';
import type { Logger } from './logger.js';

const DB_PATH = path.resolve('prisma/test.db');
const run = existsSync(DB_PATH) ? describe : describe.skip;

describe('monthsSince (unit)', () => {
  it('counts whole calendar months and never goes negative', () => {
    expect(monthsSince(new Date('2026-01-15'), new Date('2026-07-15'))).toBe(6);
    expect(monthsSince(new Date('2026-01-15'), new Date('2026-07-14'))).toBe(5); // day not yet reached
    expect(monthsSince(new Date('2025-09-20'), new Date('2026-09-20'))).toBe(12);
    expect(monthsSince(new Date('2027-01-01'), new Date('2026-01-01'))).toBe(0); // future
    expect(monthsSince(null, new Date())).toBe(0);
  });
});

run('AchievementService (integration)', () => {
  let prisma: PrismaClient;
  let svc: AchievementService;
  let bus: EventBus;
  let published: { key: string; displayName: string }[];

  const P = 'itest_ach_';
  const noop = () => {};
  const logger = { info: noop, warn: noop, error: noop, debug: noop, child: () => logger } as unknown as Logger;
  const config = { twitch: { channel: 'primary' } } as unknown as AppConfig;

  /** Create a user, optionally aged (firstSeenAt N months ago). */
  const mkUser = async (n: number, monthsAgo = 0) => {
    const id = `${P}${n}`;
    const firstSeenAt = new Date();
    firstSeenAt.setMonth(firstSeenAt.getMonth() - monthsAgo);
    await prisma.user.upsert({
      where: { id },
      create: { id, login: id, displayName: `Ach${n}`, firstSeenAt },
      update: { displayName: `Ach${n}`, firstSeenAt },
    });
    return id;
  };
  const keys = (u: { key: string }[]) => u.map((x) => x.key).sort();

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: `file:${DB_PATH}` } } });
  });

  const wipe = async () => {
    const ids = (await prisma.user.findMany({ where: { id: { startsWith: P } }, select: { id: true } })).map((u) => u.id);
    await prisma.userAchievement.deleteMany({ where: { userId: { in: ids } } });
    await prisma.eventLog.deleteMany({ where: { userId: { in: ids } } });
    await prisma.quote.deleteMany({ where: { OR: [{ quotedUserId: { in: ids } }, { createdById: { in: ids } }] } });
    await prisma.firstCheckin.deleteMany({ where: { userId: { in: ids } } });
    await prisma.firstStat.deleteMany({ where: { userId: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { startsWith: P } } });
  };

  beforeEach(async () => {
    await wipe();
    bus = new EventBus();
    published = [];
    bus.on('achievementUnlocked', (e) => {
      published.push({ key: e.key, displayName: e.displayName });
    });
    svc = new AchievementService(new Storage(prisma), bus, config, logger);
  });

  afterAll(async () => {
    await wipe();
    await prisma.$disconnect();
  });

  // ── !first ────────────────────────────────────────────────────────────────
  it('grants tiered !first achievements only up to the reached threshold', async () => {
    const u = await mkUser(1);
    await prisma.firstStat.create({ data: { userId: u, firsts: 10, topTens: 10 } });

    const earned = await svc.evaluate(u, 'first');
    expect(keys(earned)).toEqual(['first.blood', 'first.champion1', 'first.podium1']);
    // Champion II (50) not reached.
    expect(keys(earned)).not.toContain('first.champion2');
  });

  it('is idempotent — re-evaluating grants nothing new', async () => {
    const u = await mkUser(2);
    await prisma.firstStat.create({ data: { userId: u, firsts: 1, topTens: 1 } });
    expect((await svc.evaluate(u, 'first')).length).toBe(1); // first.blood
    expect(await svc.evaluate(u, 'first')).toEqual([]);
    expect(await prisma.userAchievement.count({ where: { userId: u } })).toBe(1);
  });

  it('grants Speed Demon only for a sub-10s check-in', async () => {
    const slow = await mkUser(3);
    const fast = await mkUser(4);
    await prisma.firstCheckin.create({ data: { userId: slow, streamKey: 's1', place: 3, timeSeconds: 42 } });
    await prisma.firstCheckin.create({ data: { userId: fast, streamKey: 's1', place: 1, timeSeconds: 4 } });

    expect(keys(await svc.evaluate(slow, 'first'))).not.toContain('first.speed');
    expect(keys(await svc.evaluate(fast, 'first'))).toContain('first.speed');
  });

  // ── Quotes ────────────────────────────────────────────────────────────────
  it('counts being quoted and adding quotes separately', async () => {
    const subject = await mkUser(5);
    const author = await mkUser(6);
    await prisma.quote.create({ data: { text: 'q', quotedUser: 'Ach5', quotedUserId: subject, quoteDate: '2026-01-01', createdById: author } });

    expect(keys(await svc.evaluate(subject, 'quote'))).toEqual(['quote.quoted1']);
    expect(keys(await svc.evaluate(author, 'quote'))).toEqual(['quote.scribe1']);
  });

  // ── Subs / bits (EventLog) ────────────────────────────────────────────────
  it('uses the MAX cumulative resub months and the SUM of gifted subs', async () => {
    const u = await mkUser(7);
    await prisma.eventLog.create({ data: { type: 'sub', userId: u } });
    // Twitch sends cumulative months, so one observed resub establishes tenure.
    await prisma.eventLog.create({ data: { type: 'resub', userId: u, amount: 7 } });
    await prisma.eventLog.create({ data: { type: 'subgift', userId: u, amount: 3 } });
    await prisma.eventLog.create({ data: { type: 'subgift', userId: u, amount: 2 } });

    const earned = keys(await svc.evaluate(u, 'sub'));
    expect(earned).toContain('sub.welcome');
    expect(earned).toContain('sub.loyal1'); // 3 months
    expect(earned).toContain('sub.loyal2'); // 6 months
    expect(earned).not.toContain('sub.loyal3'); // 12 not reached
    expect(earned).toContain('sub.santa1'); // 3 + 2 = 5 gifted
    expect(earned).toContain('sub.santa2');
  });

  it('sums cheered bits across events', async () => {
    const u = await mkUser(8);
    await prisma.eventLog.create({ data: { type: 'bits', userId: u, amount: 400 } });
    await prisma.eventLog.create({ data: { type: 'bits', userId: u, amount: 700 } });

    const earned = keys(await svc.evaluate(u, 'bits'));
    expect(earned).toEqual(['bits.fireworks', 'bits.first', 'bits.sparkler']); // sorted; 1100 total
    expect(earned).not.toContain('bits.supernova');
  });

  // ── Tenure ────────────────────────────────────────────────────────────────
  it('grants tenure tiers and a per-year Anniversary occurrence', async () => {
    const u = await mkUser(9, 24); // known for 2 years
    await prisma.userName.create({ data: { userId: u, name: 'Nick', normalized: `${P}nick`, kind: 'alias' } });

    const earned = keys(await svc.evaluate(u, 'daily'));
    expect(earned).toContain('tenure.foster1');
    expect(earned).toContain('tenure.foster3');
    expect(earned).toContain('tenure.names');
    expect(earned).toContain('tenure.anniversary:2'); // occurrence-keyed
  });

  it('re-awards Anniversary the following year as a new occurrence', async () => {
    const u = await mkUser(10, 12);
    expect(keys(await svc.evaluate(u, 'daily'))).toContain('tenure.anniversary:1');

    // A year passes: age the account and re-evaluate.
    const older = new Date();
    older.setMonth(older.getMonth() - 24);
    await prisma.user.update({ where: { id: u }, data: { firstSeenAt: older } });
    expect(keys(await svc.evaluate(u, 'daily'))).toContain('tenure.anniversary:2');
    expect(await prisma.userAchievement.count({ where: { userId: u, key: { startsWith: 'tenure.anniversary' } } })).toBe(2);
  });

  // ── Surfacing + backfill ──────────────────────────────────────────────────
  it('publishes achievementUnlocked for live unlocks', async () => {
    const u = await mkUser(11);
    await prisma.firstStat.create({ data: { userId: u, firsts: 1, topTens: 1 } });
    await svc.evaluate(u, 'first');
    expect(published).toEqual([{ key: 'first.blood', displayName: 'Ach11' }]);
  });

  it('backfills history SILENTLY (no chat/overlay spam)', async () => {
    const u = await mkUser(12);
    await prisma.firstStat.create({ data: { userId: u, firsts: 100, topTens: 100 } });

    const res = await svc.backfillAll();
    expect(res.granted).toBeGreaterThanOrEqual(7); // all first tiers
    expect(published).toEqual([]); // nothing announced
    expect(await prisma.userAchievement.count({ where: { userId: u } })).toBeGreaterThanOrEqual(7);
  });

  it('reports progress for the whole catalog, unlocked or not', async () => {
    const u = await mkUser(13);
    await prisma.firstStat.create({ data: { userId: u, firsts: 5, topTens: 5 } });
    await svc.evaluate(u, 'first');

    const list = await svc.listForUser(u);
    expect(list.length).toBeGreaterThan(25); // full catalog is always returned
    const blood = list.find((a) => a.key === 'first.blood')!;
    expect(blood).toMatchObject({ unlocked: true, current: 5, target: 1 });
    expect(blood.unlockedAt).toBeTruthy();
    const champ = list.find((a) => a.key === 'first.champion1')!;
    expect(champ).toMatchObject({ unlocked: false, current: 5, target: 10 }); // progress toward locked
  });
});
