import { describe, it, expect, beforeEach } from 'vitest';
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
function storage(seed?: string) {
  let value = seed;
  return {
    prisma: {
      setting: {
        findUnique: async () => (value === undefined ? null : { key: 'crowd.config', value }),
        upsert: async (args: { create: { value: string }; update: { value: string } }) => {
          value = args.update.value ?? args.create.value;
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

describe('CrowdHypeService live controls', () => {
  let svc: CrowdHypeService;

  beforeEach(async () => {
    svc = new CrowdHypeService(storage(), logger);
    await svc.init();
  });

  it('starts clean — live overrides are never persisted', () => {
    expect(svc.getLive()).toEqual({
      mode: 'regular', pausedUntil: 0, clearedAt: 0, quiescedUntil: 0, sim: false,
      pausedForever: false, quiescedForever: false,
    });
  });

  it('toggles slow mode and ignores anything that is not a mode', () => {
    expect(svc.setMode('slow').mode).toBe('slow');
    expect(svc.setMode('nonsense').mode).toBe('regular');
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

  it('cancels both holds on resume, leaving mode and sim alone', () => {
    svc.setMode('slow');
    svc.setSim(true);
    svc.clearAndPause(60);
    svc.quiesceAndPause(60);
    const live = svc.resume();
    expect(live.pausedUntil).toBe(0);
    expect(live.quiescedUntil).toBe(0);
    expect(live.mode).toBe('slow');
    expect(live.sim).toBe(true);
  });

  it('hands out a copy of the live state, not the original', () => {
    const live = svc.getLive();
    live.mode = 'slow';
    expect(svc.getLive().mode).toBe('regular');
  });
});
