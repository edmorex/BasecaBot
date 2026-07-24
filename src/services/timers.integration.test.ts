import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { Storage } from './storage/index.js';
import { TimerService, TimerError, timerKey } from './timers.js';

const DB_PATH = path.resolve('prisma/test.db');
const hasDb = existsSync(DB_PATH);
const run = hasDb ? describe : describe.skip;

describe('timerKey (unit)', () => {
  it('lowercases and trims', () => {
    expect(timerKey('  Socials ')).toBe('socials');
    expect(timerKey('DISCORD')).toBe('discord');
  });
});

run('TimerService (integration)', () => {
  let prisma: PrismaClient;
  let timers: TimerService;
  let fired: string[];
  let live: boolean;

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: `file:${DB_PATH}` } } });
  });

  beforeEach(async () => {
    await prisma.timer.deleteMany({});
    vi.useFakeTimers();
    fired = [];
    live = true;
    timers = new TimerService(new Storage(prisma));
    timers.configure({ fire: (cmd) => void fired.push(cmd), isLive: () => live });
  });

  afterEach(() => {
    timers.stopAllRuntime();
    vi.useRealTimers();
  });

  afterAll(async () => {
    await prisma.timer.deleteMany({});
    await prisma.$disconnect();
  });

  it('creates timers, rejecting duplicates and bad input', async () => {
    const t = await timers.add('Socials', 60, '!socials');
    expect(t).toMatchObject({ name: 'Socials', periodSeconds: 60, command: '!socials', looping: false });
    await expect(timers.add('socials', 30, '!x')).rejects.toBeInstanceOf(TimerError); // case-insensitive dup
    await expect(timers.add('two words', 30, '!x')).rejects.toBeInstanceOf(TimerError);
    await expect(timers.add('bad', 0, '!x')).rejects.toBeInstanceOf(TimerError);
    await expect(timers.add('nobang', 30, 'socials')).rejects.toBeInstanceOf(TimerError);
  });

  it('fires a one-shot once after the period and then goes idle', async () => {
    await timers.add('once', 10, '!hello');
    await timers.start('once');
    expect(timers.status('once')).toBe(10);
    await vi.advanceTimersByTimeAsync(9000);
    expect(fired).toEqual([]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(fired).toEqual(['!hello']);
    // No repeat, and it is no longer running.
    await vi.advanceTimersByTimeAsync(20000);
    expect(fired).toEqual(['!hello']);
    expect(timers.status('once')).toBe(0);
  });

  it('loops every period and persists loop mode', async () => {
    await timers.add('loopy', 5, '!ping');
    const def = await timers.loop('loopy');
    expect(def.looping).toBe(true);
    expect((await prisma.timer.findUnique({ where: { key: 'loopy' } }))?.looping).toBe(true);
    await vi.advanceTimersByTimeAsync(16000); // 3 full periods
    expect(fired).toEqual(['!ping', '!ping', '!ping']);
  });

  it('skips loop fires while offline but keeps looping', async () => {
    await timers.add('offl', 5, '!ping');
    await timers.loop('offl');
    live = false;
    await vi.advanceTimersByTimeAsync(11000); // 2 periods, offline → skipped
    expect(fired).toEqual([]);
    live = true;
    await vi.advanceTimersByTimeAsync(5000); // next period, now live
    expect(fired).toEqual(['!ping']);
  });

  it('stop disarms loop mode and aborts the countdown', async () => {
    await timers.add('s', 5, '!ping');
    await timers.loop('s');
    await vi.advanceTimersByTimeAsync(5000);
    expect(fired).toEqual(['!ping']);
    const def = await timers.stop('s');
    expect(def.looping).toBe(false);
    expect(timers.status('s')).toBe(0);
    await vi.advanceTimersByTimeAsync(20000);
    expect(fired).toEqual(['!ping']); // no more fires
  });

  it('start clears a previously-armed loop', async () => {
    await timers.add('m', 5, '!ping');
    await timers.loop('m');
    const def = await timers.start('m'); // switches to one-shot
    expect(def.looping).toBe(false);
    await vi.advanceTimersByTimeAsync(30000);
    expect(fired).toEqual(['!ping']); // fired exactly once (one-shot), not repeatedly
  });

  it('edit updates period + command and reschedules a running loop', async () => {
    await timers.add('e', 10, '!old');
    await timers.loop('e');
    await timers.edit('e', 2, '!new');
    await vi.advanceTimersByTimeAsync(6000); // 3 periods of the NEW 2s
    expect(fired).toEqual(['!new', '!new', '!new']);
  });

  it('resumeLoops reschedules timers left looping (after a restart)', async () => {
    await prisma.timer.create({ data: { key: 'r', name: 'r', periodSeconds: 5, command: '!resumed', looping: true } });
    await timers.resumeLoops();
    await vi.advanceTimersByTimeAsync(5000);
    expect(fired).toEqual(['!resumed']);
  });

  it('delete aborts and removes the timer', async () => {
    await timers.add('d', 5, '!ping');
    await timers.loop('d');
    await timers.delete('d');
    expect(await prisma.timer.findUnique({ where: { key: 'd' } })).toBeNull();
    await vi.advanceTimersByTimeAsync(20000);
    expect(fired).toEqual([]);
    await expect(timers.delete('d')).rejects.toBeInstanceOf(TimerError);
  });
});
