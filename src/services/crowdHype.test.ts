import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  CrowdHypeService,
  CROWD_DEFAULTS,
  CROWD_RANGES,
  CROWD_ANIM_RANGES,
  LEVELS,
  safeCrowdName,
  HOLD_FOREVER,
  MIRROR_MODES,
} from './crowdHype.js';
import type { Storage } from './storage/index.js';
import type { Logger } from './logger.js';

const noop = () => {};
const logger = { info: noop, warn: noop, error: noop, debug: noop, child: () => logger } as unknown as Logger;

/** In-memory Setting table, so these stay unit tests. */
function storage(seed?: string, seatSeed?: string) {
  const rows: Record<string, string> = {};
  if (seed !== undefined) rows['crowd.config'] = seed;
  if (seatSeed !== undefined) rows['crowd.seatArt'] = seatSeed;
  return {
    prisma: {
      setting: {
        findMany: async () => Object.entries(rows).map(([key, value]) => ({ key, value })),
        upsert: async (args: { where: { key: string }; create: { value: string }; update: { value: string } }) => {
          rows[args.where.key] = args.update.value ?? args.create.value;
        },
      },
    },
  } as unknown as Storage;
}

describe('crowd config surface', () => {
  it('bounds every flat numeric setting, and every default sits inside its bounds', () => {
    for (const [key, v] of Object.entries(CROWD_DEFAULTS)) {
      if (typeof v !== 'number') continue;
      const range = CROWD_RANGES[key];
      expect(range, `${key} has no range`).toBeDefined();
      expect(v).toBeGreaterThanOrEqual(range![0]);
      expect(v).toBeLessThanOrEqual(range![1]);
    }
  });

  it('ships one animation set per excitement level, all within bounds', () => {
    expect(CROWD_DEFAULTS.levels).toHaveLength(LEVELS);
    expect(CROWD_DEFAULTS.thresholds).toHaveLength(LEVELS);
    for (const set of [...CROWD_DEFAULTS.levels, CROWD_DEFAULTS.calm]) {
      for (const [key, range] of Object.entries(CROWD_ANIM_RANGES)) {
        const v = set[key as keyof typeof set];
        expect(v).toBeGreaterThanOrEqual(range[0]);
        expect(v).toBeLessThanOrEqual(range[1]);
      }
    }
  });

  it('scrubs an uploaded silhouette name', () => {
    expect(safeCrowdName('../../etc/passwd')).toBe('passwd.png');
    expect(safeCrowdName('fan one!.PNG')).toBe('fan_one_.png');
    expect(safeCrowdName('...')).toBe('silhouette.png');
  });
});

describe('CrowdHypeService config', () => {
  let svc: CrowdHypeService;

  beforeEach(async () => {
    svc = new CrowdHypeService(storage(), logger);
    await svc.init();
  });

  it('hands out the same frozen object rather than a fresh copy each call', async () => {
    // The plugin asks for this on every tick AND every emote-bearing message, so
    // cloning per call was pure garbage. Sharing one object is only safe frozen.
    const a = svc.getConfig();
    expect(svc.getConfig()).toBe(a);
    expect(Object.isFrozen(a)).toBe(true);
    expect(Object.isFrozen(a.levels)).toBe(true);
    expect(Object.isFrozen(a.levels[0])).toBe(true);
    expect(Object.isFrozen(a.thresholds)).toBe(true);
    expect(Object.isFrozen(a.calm)).toBe(true);
  });

  it('throws rather than letting a caller corrupt the shared settings', () => {
    const c = svc.getConfig();
    expect(() => { (c as { rows: number }).rows = 99; }).toThrow();
    expect(() => { (c.levels[0] as { jumpPx: number }).jumpPx = 99; }).toThrow();
    expect(() => { (c.thresholds as number[]).push(99); }).toThrow();
  });

  it('freezes the exported defaults too, so the module constant cannot drift', () => {
    expect(Object.isFrozen(svc.defaults)).toBe(true);
    expect(Object.isFrozen(svc.defaults.calm)).toBe(true);
    expect(CROWD_DEFAULTS.rows).toBe(3);
  });

  it('replaces the frozen object on save instead of editing it', async () => {
    const before = svc.getConfig();
    const after = await svc.setConfig({ rows: 5 });
    expect(after).not.toBe(before);
    expect(before.rows).toBe(3);   // the old view is untouched
    expect(after.rows).toBe(5);
    expect(svc.getConfig()).toBe(after);
    expect(Object.isFrozen(after)).toBe(true);
  });

  it('accepts each mirror mode and rejects anything else', async () => {
    for (const mode of MIRROR_MODES) {
      expect((await svc.setConfig({ mirrorMode: mode })).mirrorMode).toBe(mode);
    }
    // An unknown mode would leave the overlay reading a value it cannot act on.
    expect((await svc.setConfig({ mirrorMode: 'sideways' as never })).mirrorMode).toBe('off');
    expect((await svc.setConfig({ mirrorMode: undefined as never })).mirrorMode).toBe('off');
  });

  it('never flips by default, so existing artwork looks unchanged', () => {
    expect(CROWD_DEFAULTS.mirrorMode).toBe('off');
    expect(MIRROR_MODES).toEqual(['off', 'move', 'position']);
  });

  it('rejects a glow colour that is not a plain hex triple', async () => {
    expect((await svc.setConfig({ glowColor: '#ABCDEF' })).glowColor).toBe('#abcdef');
    for (const bad of ['red', '#fff', 'rgb(1,2,3)', '#12345g', '']) {
      expect((await svc.setConfig({ glowColor: bad })).glowColor).toBe(CROWD_DEFAULTS.glowColor);
    }
  });

  it('keeps a chatter for survival x rate windows', async () => {
    // The documented default: a 6s window and 50 windows is five minutes from a
    // single message.
    expect(CROWD_DEFAULTS.rateWindowSeconds).toBe(6);
    expect(CROWD_DEFAULTS.survivalWindows).toBe(50);
    expect(CROWD_DEFAULTS.rateWindowSeconds * CROWD_DEFAULTS.survivalWindows).toBe(300);
  });

  it('clamps the survival horizon to at least one window', async () => {
    expect((await svc.setConfig({ survivalWindows: 0 })).survivalWindows).toBe(1);
    expect((await svc.setConfig({ survivalWindows: -5 })).survivalWindows).toBe(1);
    expect((await svc.setConfig({ survivalWindows: 99999 })).survivalWindows).toBe(1000);
  });

  it('keeps the excitement transition a fractional number of seconds', async () => {
    // 4s per level step by default; 0 is legal and means the old hard snap.
    expect(CROWD_DEFAULTS.transitionSeconds).toBe(4);
    expect((await svc.setConfig({ transitionSeconds: 2.5 })).transitionSeconds).toBe(2.5);
    expect((await svc.setConfig({ transitionSeconds: 0 })).transitionSeconds).toBe(0);
    expect((await svc.setConfig({ transitionSeconds: -1 })).transitionSeconds).toBe(0);
    expect((await svc.setConfig({ transitionSeconds: 999 })).transitionSeconds).toBe(30);
  });

  it('clamps out-of-range values', async () => {
    const c = await svc.setConfig({ rows: 99, glow: -5, rowScale: 9, spewSeconds: 0.01 });
    expect(c.rows).toBe(8);
    expect(c.glow).toBe(0);
    expect(c.rowScale).toBe(1);
    expect(c.spewSeconds).toBe(0.3);
  });

  it('forces the excitement thresholds ascending', async () => {
    // A level you could never reach, because the one above it is lower, would
    // just be a dead setting.
    const c = await svc.setConfig({ thresholds: [5, 4, 3, 2, 1] });
    expect(c.thresholds[0]).toBe(0); // level 1 is where everyone starts
    for (let i = 1; i < c.thresholds.length; i++) {
      expect(c.thresholds[i]!).toBeGreaterThanOrEqual(c.thresholds[i - 1]!);
    }
  });

  it('repairs a short or junk level list rather than rendering nothing', async () => {
    const c = await svc.setConfig({ levels: [{ jumpPx: 7 }] as never, thresholds: [] as never });
    expect(c.levels).toHaveLength(LEVELS);
    expect(c.levels[0]!.jumpPx).toBe(7);
    expect(c.levels[4]).toEqual(CROWD_DEFAULTS.levels[4]);
    expect(c.thresholds).toEqual(CROWD_DEFAULTS.thresholds);
  });

  it('loads a saved config, frozen, on start-up', async () => {
    const fresh = new CrowdHypeService(storage(JSON.stringify({ ...CROWD_DEFAULTS, rows: 6, glow: 40 })), logger);
    await fresh.init();
    expect(fresh.getConfig()).toMatchObject({ rows: 6, glow: 40 });
    expect(Object.isFrozen(fresh.getConfig())).toBe(true);
  });

  it('falls back to the defaults for an unreadable saved config', async () => {
    const fresh = new CrowdHypeService(storage('not json at all'), logger);
    await fresh.init();
    expect(fresh.getConfig().rows).toBe(CROWD_DEFAULTS.rows);
  });
});

describe('CrowdHypeService seat assignments', () => {
  let svc: CrowdHypeService;

  beforeEach(async () => {
    svc = new CrowdHypeService(storage(), logger);
    await svc.init();
  });

  it('starts with every seat on Random', () => {
    expect(svc.getSeatArt()).toEqual({});
  });

  it('pins a seat and remembers it across a restart', async () => {
    await svc.setSeatArt({ '0:0': 'fan.png', '2:3': 'other.png' });
    const store = storage(undefined, JSON.stringify(svc.getSeatArt()));
    const fresh = new CrowdHypeService(store, logger);
    await fresh.init();
    expect(fresh.getSeatArt()).toEqual({ '0:0': 'fan.png', '2:3': 'other.png' });
  });

  it('treats a blank value as back to Random', async () => {
    await svc.setSeatArt({ '0:0': 'fan.png', '0:1': '', '0:2': '   ' });
    expect(svc.getSeatArt()).toEqual({ '0:0': 'fan.png' });
  });

  it('rejects a seat key that is not row:slot', async () => {
    await svc.setSeatArt({ 'nonsense': 'fan.png', '1:2': 'fan.png', '9999:1': 'fan.png', '1': 'fan.png' });
    expect(Object.keys(svc.getSeatArt())).toEqual(['1:2']);
  });

  it('scrubs the filename, so a seat cannot point outside the library', async () => {
    await svc.setSeatArt({ '0:0': '../../etc/passwd' });
    expect(svc.getSeatArt()['0:0']).toBe('passwd.png');
  });

  it('hands out a copy, not the original', async () => {
    await svc.setSeatArt({ '0:0': 'fan.png' });
    const got = svc.getSeatArt();
    got['0:0'] = 'tampered.png';
    expect(svc.getSeatArt()['0:0']).toBe('fan.png');
  });

  it('keeps assignments for rows that do not currently exist', async () => {
    // Shrinking the layout and growing it again should not lose the work.
    await svc.setSeatArt({ '7:20': 'fan.png' });
    await svc.setConfig({ rows: 1, perRow: 2 });
    expect(svc.getSeatArt()['7:20']).toBe('fan.png');
  });

  it('drops an assignment whose file is gone when resolving for the overlay', async () => {
    await svc.setSeatArt({ '0:0': 'missing.png' });
    // listImages reads the real directory, which has no such file.
    expect(await svc.resolveSeatArt()).toEqual({});
  });
});

describe('CrowdHypeService live controls', () => {
  let svc: CrowdHypeService;

  beforeEach(async () => {
    svc = new CrowdHypeService(storage(), logger);
    await svc.init();
  });

  it('starts clean — live overrides are never persisted', () => {
    expect(svc.getLive()).toEqual({
      mode: 'regular', pausedUntil: 0, clearedAt: 0, quiescedUntil: 0, slowUntil: 0, sim: false,
      pausedForever: false, quiescedForever: false, slowForever: false,
    });
  });

  describe('slow mode', () => {
    // A frozen clock, so 'has it lapsed yet' is an exact question.
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it('holds slow mode for a while, then lets it lapse on its own', () => {
      // Slow mode is a timed hold like clear and quiesce, not a latch: the mode is
      // derived from the deadline, so it ends without anything having to clear it.
      const live = svc.slowAndPause(10);
      expect(live.mode).toBe('slow');
      expect(live.slowUntil).toBeGreaterThan(Date.now());
      expect(live.slowForever).toBe(false);

      vi.setSystemTime(new Date(Date.now() + 11_000));
      expect(svc.getLive().mode).toBe('regular');
    });

    it('holds slow mode until resume when asked', () => {
      const live = svc.slowAndWait();
      expect(live.mode).toBe('slow');
      expect(live.slowForever).toBe(true);

      // Far longer than any real stream: an endless hold must not lapse.
      vi.setSystemTime(new Date(Date.now() + 86_400_000));
      expect(svc.getLive().mode).toBe('slow');
    });

    it('falls back to the configured slow duration, and clamps a silly one', async () => {
      await svc.setConfig({ slowPauseSeconds: 45 });
      const started = Date.now();
      expect(svc.slowAndPause(undefined).slowUntil).toBe(started + 45_000);
      expect(svc.slowAndPause(99_999).slowUntil).toBe(started + 600_000);
    });
  });

  it('stamps a clear and a pause window', () => {
    const live = svc.clearAndPause(10);
    expect(live.clearedAt).toBeGreaterThan(0);
    expect(live.pausedUntil - live.clearedAt).toBe(10_000);
  });

  it('falls back to the configured delay when none is given', async () => {
    await svc.setConfig({ clearPauseSeconds: 45, quiescePauseSeconds: 20 });
    const now = Date.now();
    expect(svc.clearAndPause().pausedUntil - now).toBeGreaterThan(44_000);
    expect(svc.quiesceAndPause().quiescedUntil - now).toBeGreaterThan(19_000);
  });

  it('clamps a silly pause length', () => {
    expect(svc.clearAndPause(99999).pausedUntil - Date.now()).toBeLessThanOrEqual(600_000);
  });

  it('clears with no end until resume', () => {
    const live = svc.clearAndWait();
    expect(live.clearedAt).toBeGreaterThan(0);
    expect(live.pausedUntil).toBe(HOLD_FOREVER);
    expect(live.pausedForever).toBe(true);
    expect(live.quiescedForever).toBe(false);
  });

  it('quiesces with no end until resume', () => {
    const live = svc.quiesceAndWait();
    expect(live.quiescedUntil).toBe(HOLD_FOREVER);
    expect(live.quiescedForever).toBe(true);
    expect(live.pausedForever).toBe(false);
  });

  it('survives JSON, which Infinity would not', () => {
    // The live state crosses the wire to the admin panel; Infinity serialises to
    // null and the panel would read the hold as already expired.
    const live = JSON.parse(JSON.stringify(svc.clearAndWait()));
    expect(live.pausedUntil).toBe(HOLD_FOREVER);
    expect(Date.now() < live.pausedUntil).toBe(true);
  });

  it('still reads as held a long way into the future', () => {
    const live = svc.quiesceAndWait();
    // A decade from now the hold is still in force, which is what "until resume"
    // has to mean for the plugin's plain `now <` comparison.
    expect(Date.now() + 10 * 365 * 24 * 3600 * 1000 < live.quiescedUntil).toBe(true);
  });

  it('resume cancels an endless hold too', () => {
    svc.clearAndWait();
    svc.quiesceAndWait();
    const live = svc.resume();
    expect(live).toMatchObject({ pausedUntil: 0, quiescedUntil: 0, pausedForever: false, quiescedForever: false });
  });

  it('a timed hold replaces an endless one, and the other way round', () => {
    svc.clearAndWait();
    expect(svc.clearAndPause(10).pausedForever).toBe(false);
    expect(svc.clearAndWait().pausedForever).toBe(true);
  });

  it('cancels every hold on resume, leaving the simulation alone', () => {
    // Resume is the counterpart of all three 'until resume' buttons, so it has to
    // lift slow mode as well — otherwise the panel offers no way back out of it.
    svc.slowAndWait();
    svc.setSim(true);
    svc.clearAndPause(60);
    svc.quiesceAndPause(60);
    const live = svc.resume();
    expect(live.pausedUntil).toBe(0);
    expect(live.quiescedUntil).toBe(0);
    expect(live.slowUntil).toBe(0);
    expect(live.mode).toBe('regular');
    expect(live.sim).toBe(true);
  });

  it('hands out a copy of the live state, not the original', () => {
    const live = svc.getLive();
    live.slowUntil = HOLD_FOREVER;
    expect(svc.getLive().slowUntil).toBe(0);
    expect(svc.getLive().mode).toBe('regular');
  });
});
