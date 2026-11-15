import { describe, it, expect } from 'vitest';
import {
  readPngSize, safeImageName, FLOOF_VARIABLES, FLOOF_DEFAULTS, FLOOF_RANGES,
  FLOOF_STYLES, FLOOF_STYLE_LABELS, isFloofStyle,
  FLOOF_ACTIONS, FLOOF_ACTION_LABELS, DEFAULT_FLOOF_ACTIONS, isFloofAction,
  FloofService, FloofError, type FloofImage, type FloofAction,
} from './floof.js';
import type { Storage } from './storage/index.js';
import type { Logger } from './logger.js';

/** Build a minimal PNG header with the given dimensions. */
function pngHeader(width: number, height: number): Buffer {
  const buf = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write('IHDR', 12, 'ascii');
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

describe('readPngSize', () => {
  it('reads dimensions out of a PNG IHDR header', () => {
    expect(readPngSize(pngHeader(512, 512))).toEqual({ width: 512, height: 512 });
    expect(readPngSize(pngHeader(640, 480))).toEqual({ width: 640, height: 480 });
  });

  it('rejects non-PNG and truncated data', () => {
    expect(readPngSize(Buffer.from('not a png at all, just text here'))).toBeNull();
    expect(readPngSize(Buffer.alloc(10))).toBeNull(); // too short
    const badChunk = pngHeader(64, 64);
    badChunk.write('IDAT', 12, 'ascii'); // right signature, wrong first chunk
    expect(readPngSize(badChunk)).toBeNull();
  });
});

describe('safeImageName', () => {
  it('strips paths and forces a .png extension', () => {
    expect(safeImageName('mochi.png')).toBe('mochi.png');
    expect(safeImageName('Biscuit')).toBe('Biscuit.png');
    expect(safeImageName('../../etc/passwd')).toBe('passwd.png'); // no traversal
    expect(safeImageName('my cat!.png')).toBe('my_cat_.png'); // charset-scrubbed
  });

  it('never returns an empty or dot-leading name', () => {
    expect(safeImageName('')).toBe('floof.png');
    expect(safeImageName('...')).toBe('floof.png');
  });
});

describe('floof config surface', () => {
  it('maps every chat variable onto a real config key', () => {
    for (const key of Object.values(FLOOF_VARIABLES)) {
      expect(FLOOF_DEFAULTS).toHaveProperty(key);
    }
    // The documented defaults: 16 min base + up to 8 min extra.
    expect(FLOOF_DEFAULTS.baseSeconds).toBe(960);
    expect(FLOOF_DEFAULTS.randomSeconds).toBe(480);
    expect(FLOOF_DEFAULTS.enabled).toBe(false);
  });

  it('exposes the padding setters chat users need', () => {
    expect(Object.keys(FLOOF_VARIABLES)).toEqual(
      expect.arrayContaining(['enabled', 'base', 'random', 'despawn', 'speed', 'pad-left', 'pad-right', 'pad-top', 'pad-bottom']),
    );
  });

  it('gives each wagging style its own independent amount and speed', () => {
    // 9 degrees at 1.6Hz was the fixed behaviour before these became settings;
    // 0.63s per cycle is the same feel expressed as a period. Peek's 5 degrees
    // preserves the 60% gentling it used to get from a shared value.
    expect(FLOOF_DEFAULTS.pingpongWagDegrees).toBe(9);
    expect(FLOOF_DEFAULTS.pingpongWagSeconds).toBeCloseTo(0.63, 2);
    expect(FLOOF_DEFAULTS.peekWagDegrees).toBe(5);
    expect(FLOOF_DEFAULTS.ghostWagDegrees).toBe(12);
    // Three separate pairs, so tuning one never moves another.
    const keys = Object.keys(FLOOF_DEFAULTS).filter((k) => k.toLowerCase().includes('wag'));
    expect(keys.sort()).toEqual([
      'ghostWagDegrees', 'ghostWagSeconds',
      'peekWagDegrees', 'peekWagSeconds',
      'pingpongWagDegrees', 'pingpongWagSeconds',
    ]);
  });

  it('gives every animation style at least one chat-settable knob', () => {
    const vars = Object.keys(FLOOF_VARIABLES);
    expect(vars).toEqual(expect.arrayContaining([
      'speed', 'pingpong-wag', 'pingpong-wag-seconds', 'roll-speed',
      'hop-distance', 'hop-height', 'hop-seconds', 'hop-delay',
      'peek-height', 'peek-rise', 'peek-hold', 'peek-delay', 'peek-wag', 'peek-wag-seconds',
      'ghost-fade', 'ghost-hold', 'ghost-delay', 'ghost-wag', 'ghost-wag-seconds',
    ]));
  });

  it('bounds every numeric setting, and every default sits inside its bounds', () => {
    for (const [key, value] of Object.entries(FLOOF_DEFAULTS)) {
      if (typeof value !== 'number') continue;
      const range = FLOOF_RANGES[key];
      expect(range, `${key} has no range`).toBeDefined();
      expect(value).toBeGreaterThanOrEqual(range![0]);
      expect(value).toBeLessThanOrEqual(range![1]);
    }
  });

  it('has no Boss Floof settings left', () => {
    // Boss battles moved to their own game; nothing boss-shaped should survive here.
    for (const key of Object.keys(FLOOF_DEFAULTS)) expect(key.toLowerCase()).not.toContain('boss');
    for (const key of Object.keys(FLOOF_VARIABLES)) expect(key.toLowerCase()).not.toContain('boss');
  });
});

describe('floof animation styles', () => {
  it('lists the five styles, each with a label', () => {
    expect(FLOOF_STYLES).toEqual(['pingpong', 'roll', 'hop', 'peek', 'ghost']);
    for (const s of FLOOF_STYLES) expect(FLOOF_STYLE_LABELS[s]).toBeTruthy();
  });

  it('recognises only real style names', () => {
    expect(isFloofStyle('hop')).toBe(true);
    expect(isFloofStyle('Hop')).toBe(false); // ids are lower-case
    expect(isFloofStyle('boss')).toBe(false);
    expect(isFloofStyle(undefined)).toBe(false);
  });
});

/**
 * Which commands can claim a floof. The property that matters most is the
 * DEFAULT: a library uploaded before !spank existed has no stored preference, and
 * every one of those photos has to keep behaving exactly as it did — pet only,
 * with no migration and no backfill.
 */
const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as unknown as Logger;

/** A one-row settings table, optionally seeded with a stored actions blob. */
function storage(seed?: string) {
  const rows: Record<string, string> = {};
  if (seed !== undefined) rows['floof.imageActions'] = seed;
  return {
    saved: () => rows['floof.imageActions'],
    storage: {
      prisma: {
        setting: {
          findMany: async () => Object.entries(rows).map(([key, value]) => ({ key, value })),
          upsert: async (a: { where: { key: string }; create: { value: string }; update: { value: string } }) => {
            rows[a.where.key] = a.update.value ?? a.create.value;
          },
        },
      },
    } as unknown as Storage,
  };
}

/** A service with its settings loaded, but no image directory touched. */
async function service(seed?: string) {
  const db = storage(seed);
  const svc = new FloofService(db.storage, logger);
  await svc.init();
  return { svc, db };
}

function image(name: string, over: Partial<FloofImage> = {}): FloofImage {
  return {
    name, url: '/assets/floofs/' + name, bytes: 1,
    styles: [...FLOOF_STYLES], actions: ['pet'], taunts: [],
    label: '', displayName: 'The floof', ...over,
  };
}

describe('floof claim commands', () => {
  it('lists the two commands, each with a column heading', () => {
    expect(FLOOF_ACTIONS).toEqual(['pet', 'spank']);
    expect(FLOOF_ACTION_LABELS.pet).toBe('Pet?');
    expect(FLOOF_ACTION_LABELS.spank).toBe('Spank?');
  });

  it('recognises only real command names', () => {
    expect(isFloofAction('pet')).toBe(true);
    expect(isFloofAction('spank')).toBe(true);
    expect(isFloofAction('Spank')).toBe(false); // ids are lower-case
    expect(isFloofAction('boop')).toBe(false);
    expect(isFloofAction(undefined)).toBe(false);
  });

  it('defaults to pet only, which is how every photo behaved before', () => {
    expect([...DEFAULT_FLOOF_ACTIONS]).toEqual(['pet']);
  });
});

describe('per-photo claim commands', () => {
  it('gives a photo nobody has configured Pet on and Spank off', async () => {
    // Requirements 2 and 3 in one: an existing photo and a brand-new upload are
    // indistinguishable here, because neither has a stored preference.
    const { svc } = await service();
    expect(svc.getImageActions('mochi.png')).toEqual(['pet']);
    expect(svc.getImageActions('just-uploaded.png')).toEqual(['pet']);
  });

  it('turns spank on and off for one photo without touching another', async () => {
    const { svc } = await service();
    expect(await svc.setImageAction('mochi.png', 'spank', true)).toEqual(['pet', 'spank']);
    expect(svc.getImageActions('mochi.png')).toEqual(['pet', 'spank']);
    expect(svc.getImageActions('biscuit.png')).toEqual(['pet']);

    expect(await svc.setImageAction('mochi.png', 'pet', false)).toEqual(['spank']);
    expect(svc.getImageActions('mochi.png')).toEqual(['spank']);
  });

  it('keeps the canonical order however the boxes are ticked', async () => {
    // The panel renders columns in FLOOF_ACTIONS order; a stored ['spank','pet']
    // would make the table and the data disagree about nothing in particular.
    const { svc } = await service();
    await svc.setImageAction('m.png', 'pet', false);
    expect(await svc.setImageAction('m.png', 'spank', true)).toEqual(['spank']);
    expect(await svc.setImageAction('m.png', 'pet', true)).toEqual(['pet', 'spank']);
  });

  it('allows unticking both, and says so plainly', async () => {
    const { svc } = await service();
    await svc.setImageAction('m.png', 'pet', false);
    expect(svc.getImageActions('m.png')).toEqual([]);
  });

  it('refuses a command it does not have', async () => {
    const { svc } = await service();
    await expect(svc.setImageAction('m.png', 'boop', true)).rejects.toBeInstanceOf(FloofError);
    await expect(svc.setImageAction('m.png', '', true)).rejects.toBeInstanceOf(FloofError);
    expect(svc.getImageActions('m.png')).toEqual(['pet']);
  });

  it('hands out a copy, so a caller cannot edit the stored list', async () => {
    const { svc } = await service();
    const list = svc.getImageActions('m.png');
    list.push('spank');
    expect(svc.getImageActions('m.png')).toEqual(['pet']);
  });

  it('persists the choice and reads it back', async () => {
    const { svc, db } = await service();
    await svc.setImageAction('m.png', 'spank', true);
    const again = new FloofService(storage(db.saved()).storage, logger);
    await again.init();
    expect(again.getImageActions('m.png')).toEqual(['pet', 'spank']);
    // And a photo that was never configured still defaults, not inherits.
    expect(again.getImageActions('other.png')).toEqual(['pet']);
  });

  it('persists an emptied list, rather than falling back to the default', async () => {
    // THE case a naive "absent means default" store gets wrong: a deliberately
    // unwinnable floof must not quietly become pet-able again on restart.
    const { svc, db } = await service();
    await svc.setImageAction('m.png', 'pet', false);
    const again = new FloofService(storage(db.saved()).storage, logger);
    await again.init();
    expect(again.getImageActions('m.png')).toEqual([]);
  });

  it('ignores junk in a hand-edited row', async () => {
    const { svc } = await service(JSON.stringify({
      'a.png': ['spank', 'boop', 'pet', 'pet'],
      'b.png': 'not a list',
      'c.png': [],
    }));
    expect(svc.getImageActions('a.png')).toEqual(['pet', 'spank']); // deduped, ordered
    expect(svc.getImageActions('b.png')).toEqual(['pet']);          // unreadable -> default
    expect(svc.getImageActions('c.png')).toEqual([]);               // a real empty choice
  });
});

describe('spawning and claim commands', () => {
  it('never puts a floof nobody can win on screen at random', async () => {
    // It would just cross the screen and time out. Same reasoning as a photo with
    // every animation switched off.
    const { svc } = await service();
    svc.listImages = async () => [image('dead.png', { actions: [] }), image('live.png')];
    for (let i = 0; i < 40; i++) {
      expect((await svc.pickSpawn()).image.name).toBe('live.png');
    }
  });

  it('still spawns one by name, so it can be tested', async () => {
    const { svc } = await service();
    svc.listImages = async () => [image('dead.png', { actions: [] })];
    expect((await svc.pickSpawn('dead.png')).image.name).toBe('dead.png');
  });

  it('explains itself when nothing is winnable', async () => {
    const { svc } = await service();
    svc.listImages = async () => [image('a.png', { actions: [] }), image('b.png', { actions: [] })];
    await expect(svc.pickSpawn()).rejects.toThrow(/both !pet and !spank switched off/);
  });

  it('still reports an animation problem as an animation problem', async () => {
    // The two exclusions must not be confused: a winnable photo with no styles
    // left has to keep its own message.
    const { svc } = await service();
    svc.listImages = async () => [image('a.png', { styles: [] })];
    await expect(svc.pickSpawn()).rejects.toThrow(/animations switched off/);
  });

  it('passes the allowed commands to whoever spawns it', async () => {
    const { svc } = await service();
    const only: FloofAction[] = ['spank'];
    svc.listImages = async () => [image('a.png', { actions: only })];
    expect((await svc.pickSpawn()).image.actions).toEqual(['spank']);
  });
});
