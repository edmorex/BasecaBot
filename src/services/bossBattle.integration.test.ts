import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { Storage } from './storage/index.js';
import { BossBattleService, BossError, safeBossFile } from './bossBattle.js';
import { AchievementService } from './achievements.js';
import { EventBus } from '../core/eventBus.js';
import type { AppConfig } from './config.js';
import type { Logger } from './logger.js';

const DB_PATH = path.resolve('prisma/test.db');
const run = existsSync(DB_PATH) ? describe : describe.skip;

describe('safeBossFile (unit)', () => {
  it('strips paths and forces the expected extension', () => {
    expect(safeBossFile('../../etc/passwd', '.png')).toBe('passwd.png');
    expect(safeBossFile('My Boss.PNG', '.png')).toBe('My_Boss.png');
    expect(safeBossFile('theme.mp3', '.mp3')).toBe('theme.mp3');
  });

  it('never produces an extension-less name from a hostile input', () => {
    // A bare "..." must not become a file the asset route refuses to serve.
    expect(safeBossFile('...', '.png')).toBe('boss.png');
    expect(safeBossFile('', '.png')).toBe('boss.png');
  });

  it('scrubs characters the asset route would reject', () => {
    expect(safeBossFile('a b/c?d.png', '.png')).toBe('c_d.png');
    expect(safeBossFile('sound fx!.mp3', '.mp3')).toBe('sound_fx_.mp3');
  });
});

run('BossBattleService (integration)', () => {
  let prisma: PrismaClient;
  let svc: BossBattleService;
  const noop = () => {};
  const logger = { info: noop, warn: noop, error: noop, debug: noop, child: () => logger } as unknown as Logger;

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: `file:${DB_PATH}` } } });
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.boss.deleteMany({});
    await prisma.setting.deleteMany({ where: { key: 'boss.config' } });
    svc = new BossBattleService({ prisma } as unknown as Storage, logger);
    await svc.init();
  });

  const make = (over: Record<string, unknown> = {}) =>
    svc.createBoss({ name: 'Dread Moth', hp: 30, emotesPublic: ['Kappa'], ...over });

  it('creates a boss and reads its JSON columns back as arrays', async () => {
    const boss = await make({ emotesPrivate: ['LUL'], emotesHeal: ['HeyGuys'], tauntBattle: ['is that all?'], styles: ['spin', 'darting'] });
    const read = await svc.getBoss(boss.id);
    expect(read).toMatchObject({
      name: 'Dread Moth', hp: 30,
      emotesPublic: ['Kappa'], emotesPrivate: ['LUL'], emotesHeal: ['HeyGuys'],
      tauntBattle: ['is that all?'], styles: ['spin', 'darting'],
    });
  });

  it('refuses a nameless boss', async () => {
    await expect(svc.createBoss({ name: '   ' })).rejects.toBeInstanceOf(BossError);
  });

  it('clamps out-of-range stats instead of storing them', async () => {
    const boss = await make({ hp: 9999, escapeSeconds: 1, speedFull: 99, size: 300 });
    expect(boss.hp).toBe(500);
    expect(boss.escapeSeconds).toBe(10);
    expect(boss.speedFull).toBe(10);
    expect(boss.size).toBe(256); // snapped to the nearest offered size
  });

  it('falls back to a movement style rather than leaving a boss frozen', async () => {
    const boss = await make({ styles: ['nonsense'] });
    expect(boss.styles).toEqual(['pingpong']);
  });

  it('de-duplicates emote lists but keeps case variants apart', async () => {
    const boss = await make({ emotesPublic: ['Kappa', 'Kappa', ' Kappa ', 'kappa'] });
    expect(boss.emotesPublic).toEqual(['Kappa', 'kappa']);
  });

  it('updates one field without disturbing the rest', async () => {
    const boss = await make({ emotesPublic: ['Kappa'], tauntOpening: 'hello' });
    const updated = await svc.updateBoss(boss.id, { hp: 12 });
    expect(updated).toMatchObject({ hp: 12, emotesPublic: ['Kappa'], tauntOpening: 'hello' });
  });

  it('picks only from the enabled pool', async () => {
    await make({ name: 'Disabled One', enabled: false, image: 'x.png' });
    for (let i = 0; i < 12; i++) expect(await svc.randomBoss()).toBeNull();
    const on = await make({ name: 'Enabled One', enabled: true, image: 'x.png' });
    expect((await svc.randomBoss())?.id).toBe(on.id);
  });

  it('keeps an empty portrait empty rather than inventing a filename', async () => {
    expect((await make({ image: '' })).image).toBe('');
    expect((await make({ name: 'Blank two', image: '   ' })).image).toBe('');
  });

  it('refuses to start a boss with no portrait, with a message worth reading', async () => {
    const boss = await make({ image: '' });
    await expect(svc.pickBoss(boss.id)).rejects.toThrow(/no portrait/i);
    await expect(svc.pickBoss(null)).rejects.toThrow(/no portrait/i);
  });

  it('explains the empty roster rather than failing silently', async () => {
    await expect(svc.pickBoss(null)).rejects.toThrow(/No enabled bosses/i);
    await expect(svc.pickBoss(999999)).rejects.toThrow(/no longer exists/i);
  });

  it('deletes a boss', async () => {
    const boss = await make();
    await svc.deleteBoss(boss.id);
    expect(await svc.getBoss(boss.id)).toBeNull();
    await expect(svc.deleteBoss(boss.id)).rejects.toBeInstanceOf(BossError);
  });

  it('persists clamped settings across a reload', async () => {
    await svc.setConfig({ cooldownSeconds: 45, startDelaySeconds: 9999, dartSeconds: 0.75 });
    const fresh = new BossBattleService({ prisma } as unknown as Storage, logger);
    await fresh.init();
    expect(fresh.getConfig()).toMatchObject({ cooldownSeconds: 45, startDelaySeconds: 120, dartSeconds: 0.75 });
  });
});

run('Boss Battle scoreboard + achievements (integration)', () => {
  let prisma: PrismaClient;
  let svc: BossBattleService;
  let achievements: AchievementService;
  const P = 'itest_boss_';
  const noop = () => {};
  const logger = { info: noop, warn: noop, error: noop, debug: noop, child: () => logger } as unknown as Logger;
  const config = { twitch: { channel: 'primary' } } as unknown as AppConfig;

  const mkUser = async (n: number) => {
    const id = `${P}${n}`;
    await prisma.user.upsert({
      where: { id },
      create: { id, login: id, displayName: `Boss${n}` },
      update: {},
    });
    return id;
  };

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: `file:${DB_PATH}` } } });
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    const ids = (await prisma.user.findMany({ where: { id: { startsWith: P } }, select: { id: true } })).map((u) => u.id);
    await prisma.userAchievement.deleteMany({ where: { userId: { in: ids } } });
    await prisma.bossStat.deleteMany({ where: { userId: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { startsWith: P } } });
    const storage = { prisma } as unknown as Storage;
    svc = new BossBattleService(storage, logger);
    achievements = new AchievementService(storage, new EventBus(), config, logger);
  });

  it('credits every attacker but only the killer gets a kill', async () => {
    const a = await mkUser(1);
    const b = await mkUser(2);
    await svc.recordDefeat([a, b], b);
    expect(await svc.statsFor(a)).toMatchObject({ defeats: 1, kills: 0 });
    expect(await svc.statsFor(b)).toMatchObject({ defeats: 1, kills: 1 });
  });

  it('accumulates across battles and ranks players', async () => {
    const a = await mkUser(1);
    const b = await mkUser(2);
    await svc.recordDefeat([a, b], a);
    await svc.recordDefeat([a], a);
    expect(await svc.statsFor(a)).toMatchObject({ defeats: 2, kills: 2, rank: 1 });
    expect((await svc.statsFor(b)).rank).toBe(2);
    expect((await svc.topDefeats())[0]).toMatchObject({ displayName: 'Boss1', defeats: 2 });
  });

  it('never double-counts a user listed twice in one battle', async () => {
    const a = await mkUser(1);
    await svc.recordDefeat([a, a, a], a);
    expect(await svc.statsFor(a)).toMatchObject({ defeats: 1, kills: 1 });
  });

  it('reports a clean zero for someone who has never fought', async () => {
    const a = await mkUser(1);
    expect(await svc.statsFor(a)).toEqual({ defeats: 0, kills: 0, rank: null });
  });

  it('unlocks Basecamp Protector I and Basecamp Hero off the real metrics', async () => {
    const a = await mkUser(1);
    const b = await mkUser(2);
    await svc.recordDefeat([a, b], b);
    expect((await achievements.evaluate(a, 'boss')).map((u) => u.key)).toEqual(['boss.protector1']);
    // The killer earns the Hero badge on top of the participation one.
    expect((await achievements.evaluate(b, 'boss')).map((u) => u.key).sort()).toEqual(['boss.hero', 'boss.protector1']);
    // Re-evaluating is idempotent — no duplicate unlocks.
    expect(await achievements.evaluate(b, 'boss')).toEqual([]);
  });

  it('unlocks Protector II only at 25 battles', async () => {
    const a = await mkUser(1);
    await prisma.bossStat.create({ data: { userId: a, defeats: 24, kills: 0 } });
    expect((await achievements.evaluate(a, 'boss')).map((u) => u.key)).toEqual(['boss.protector1']);
    await prisma.bossStat.update({ where: { userId: a }, data: { defeats: 25 } });
    expect((await achievements.evaluate(a, 'boss')).map((u) => u.key)).toEqual(['boss.protector2']);
  });
});
