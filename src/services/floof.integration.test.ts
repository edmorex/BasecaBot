import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { existsSync } from 'node:fs';
import { writeFile, unlink, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import type { Storage } from './storage/index.js';
import type { Logger } from './logger.js';
import { FloofService, FloofError, FLOOF_DIR, FLOOF_STYLES, DEFAULT_TAUNT, DEFAULT_FLOOF_NAME, MAX_FLOOF_NAME } from './floof.js';

const DB_PATH = path.resolve('prisma/test.db');
const run = existsSync(DB_PATH) ? describe : describe.skip;

/** A minimal but genuinely valid 1x1-style square PNG header the service accepts. */
function squarePng(size = 64): Buffer {
  const buf = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write('IHDR', 12, 'ascii');
  buf.writeUInt32BE(size, 16);
  buf.writeUInt32BE(size, 20);
  return buf;
}

run('FloofService photos + animation styles (integration)', () => {
  let prisma: PrismaClient;
  let svc: FloofService;
  const noop = () => {};
  const logger = { info: noop, warn: noop, error: noop, debug: noop, child: () => logger } as unknown as Logger;
  // Distinctive prefix so the real photo library is never touched.
  const P = 'ztest-floof-';
  const A = `${P}a.png`;
  const B = `${P}b.png`;
  const C = `${P}c.png`;

  const wipeFiles = async () => {
    let names: string[] = [];
    try {
      names = await readdir(FLOOF_DIR);
    } catch {
      return;
    }
    for (const n of names.filter((x) => x.startsWith(P))) {
      await unlink(path.join(FLOOF_DIR, n)).catch(() => {});
    }
  };

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: `file:${DB_PATH}` } } });
    await mkdir(FLOOF_DIR, { recursive: true });
  });
  afterAll(async () => {
    await wipeFiles();
    await prisma.setting.deleteMany({ where: { key: { startsWith: 'floof.' } } });
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await wipeFiles();
    await prisma.setting.deleteMany({ where: { key: { startsWith: 'floof.' } } });
    for (const n of [A, B, C]) await writeFile(path.join(FLOOF_DIR, n), squarePng());
    svc = new FloofService({ prisma } as unknown as Storage, logger);
    await svc.init();
  });

  /** Only our test photos, so a developer's real library can't skew a result. */
  const mine = async () => (await svc.listImages()).filter((i) => i.name.startsWith(P));

  it('lets every photo use every animation style by default', async () => {
    for (const im of await mine()) expect(im.styles).toEqual([...FLOOF_STYLES]);
    expect(svc.getImageStyles(A)).toEqual([...FLOOF_STYLES]);
  });

  it('narrows a photo to the styles left ticked', async () => {
    await svc.setImageStyle(A, 'roll', false);
    await svc.setImageStyle(A, 'ghost', false);
    expect(svc.getImageStyles(A)).toEqual(['pingpong', 'hop', 'peek']);
    // The others are untouched.
    expect(svc.getImageStyles(B)).toEqual([...FLOOF_STYLES]);
  });

  it('keeps styles in canonical order however they are toggled', async () => {
    for (const s of FLOOF_STYLES) await svc.setImageStyle(A, s, false);
    await svc.setImageStyle(A, 'ghost', true);
    await svc.setImageStyle(A, 'pingpong', true);
    await svc.setImageStyle(A, 'hop', true);
    expect(svc.getImageStyles(A)).toEqual(['pingpong', 'hop', 'ghost']);
  });

  it('rejects a style it does not know', async () => {
    await expect(svc.setImageStyle(A, 'breakdance', true)).rejects.toBeInstanceOf(FloofError);
  });

  it('remembers style choices across a restart', async () => {
    await svc.setImageStyle(A, 'peek', false);
    const fresh = new FloofService({ prisma } as unknown as Storage, logger);
    await fresh.init();
    expect(fresh.getImageStyles(A)).toEqual(['pingpong', 'roll', 'hop', 'ghost']);
  });

  it('forgets a deleted photo, so its settings cannot haunt a re-upload', async () => {
    await svc.setImageStyle(A, 'hop', false);
    await svc.deleteImage(A);
    await writeFile(path.join(FLOOF_DIR, A), squarePng());
    expect(svc.getImageStyles(A)).toEqual([...FLOOF_STYLES]);
  });

  describe('pickSpawn', () => {
    /** Restrict the library to our fixtures so the draws are predictable. */
    const only = async (keep: string[]) => {
      for (const im of await svc.listImages()) {
        if (!keep.includes(im.name)) {
          for (const s of FLOOF_STYLES) await svc.setImageStyle(im.name, s, false);
        }
      }
    };

    it('picks both a photo and one of that photo’s styles', async () => {
      await only([A]);
      for (let i = 0; i < 25; i++) {
        const got = await svc.pickSpawn();
        expect(got.image.name).toBe(A);
        expect(FLOOF_STYLES).toContain(got.style);
      }
    });

    it('never picks a style the photo has switched off', async () => {
      await only([A]);
      await svc.setImageStyle(A, 'pingpong', false);
      await svc.setImageStyle(A, 'roll', false);
      await svc.setImageStyle(A, 'hop', false);
      const seen = new Set<string>();
      for (let i = 0; i < 60; i++) seen.add((await svc.pickSpawn()).style);
      expect([...seen].sort()).toEqual(['ghost', 'peek']);
    });

    it('honours an explicit style by only drawing photos that allow it', async () => {
      await only([A, B]);
      await svc.setImageStyle(B, 'roll', false);
      for (let i = 0; i < 25; i++) {
        const got = await svc.pickSpawn(null, 'roll');
        expect(got).toMatchObject({ style: 'roll' });
        expect(got.image.name).toBe(A);
      }
    });

    it('honours an explicit photo even with that style switched off', async () => {
      // An admin naming both by hand is testing something; do as they asked.
      await svc.setImageStyle(A, 'ghost', false);
      expect(await svc.pickSpawn(A, 'ghost')).toMatchObject({ style: 'ghost' });
    });

    it('skips a photo with every style unticked, which is how one is shelved', async () => {
      await only([A, C]);
      for (const s of FLOOF_STYLES) await svc.setImageStyle(C, s, false);
      for (let i = 0; i < 30; i++) expect((await svc.pickSpawn()).image.name).toBe(A);
    });

    it('explains itself when no photo allows the requested style', async () => {
      await only([A]);
      await svc.setImageStyle(A, 'peek', false);
      await expect(svc.pickSpawn(null, 'peek')).rejects.toThrow(/Peek/);
    });

    it('explains itself when every photo is shelved', async () => {
      await only([]);
      await expect(svc.pickSpawn()).rejects.toThrow(/switched off/i);
    });

    it('rejects a photo that does not exist', async () => {
      await expect(svc.pickSpawn('not-a-real-floof.png')).rejects.toThrow(/no floof photo called/i);
    });

    it('spreads its draws over the available photos', async () => {
      await only([A, B]);
      const seen = new Set<string>();
      for (let i = 0; i < 80; i++) seen.add((await svc.pickSpawn()).image.name);
      expect([...seen].sort()).toEqual([A, B].sort());
    });
  });

  describe('floof names', () => {
    it('starts unnamed, and reads as the stand-in until named', async () => {
      expect(svc.getImageName(A)).toBe('');
      expect(svc.getImageDisplayName(A)).toBe(DEFAULT_FLOOF_NAME);
      for (const im of await mine()) {
        expect(im.label).toBe('');
        expect(im.displayName).toBe(DEFAULT_FLOOF_NAME);
      }
    });

    it('names one floof without touching the others', async () => {
      await svc.setImageName(A, 'Mochi');
      expect(svc.getImageName(A)).toBe('Mochi');
      expect(svc.getImageDisplayName(A)).toBe('Mochi');
      expect(svc.getImageDisplayName(B)).toBe(DEFAULT_FLOOF_NAME);
    });

    it('tidies the typed name', async () => {
      expect(await svc.setImageName(A, '  Sir   Fluffington  ')).toBe('Sir Fluffington');
      expect(await svc.setImageName(A, 'x'.repeat(200))).toHaveLength(MAX_FLOOF_NAME);
    });

    it('clears a name back to the stand-in', async () => {
      await svc.setImageName(A, 'Mochi');
      expect(await svc.setImageName(A, '   ')).toBe('');
      expect(svc.getImageDisplayName(A)).toBe(DEFAULT_FLOOF_NAME);
    });

    it('remembers names across a restart', async () => {
      await svc.setImageName(A, 'Mochi');
      const fresh = new FloofService({ prisma } as unknown as Storage, logger);
      await fresh.init();
      expect(fresh.getImageDisplayName(A)).toBe('Mochi');
    });

    it('forgets a deleted floof’s name, so a re-upload is unnamed again', async () => {
      await svc.setImageName(A, 'Mochi');
      await svc.deleteImage(A);
      await writeFile(path.join(FLOOF_DIR, A), squarePng());
      expect(svc.getImageDisplayName(A)).toBe(DEFAULT_FLOOF_NAME);
    });

    it('hands the spawning floof its own name', async () => {
      await svc.setImageName(A, 'Mochi');
      const got = await svc.pickSpawn(A);
      expect(got.image).toMatchObject({ label: 'Mochi', displayName: 'Mochi' });
    });
  });

  describe('per-floof taunts', () => {
    it('gives a brand-new floof the default taunt', async () => {
      expect(svc.getImageTaunts(A)).toEqual([DEFAULT_TAUNT]);
      for (const im of await mine()) expect(im.taunts).toEqual([DEFAULT_TAUNT]);
    });

    it('keeps each floof’s lines separate', async () => {
      await svc.addImageTaunt(A, 'pet me you coward');
      await svc.addImageTaunt(B, 'i require attention');
      expect(svc.getImageTaunts(A)).toEqual([DEFAULT_TAUNT, 'pet me you coward']);
      expect(svc.getImageTaunts(B)).toEqual([DEFAULT_TAUNT, 'i require attention']);
      expect(svc.getImageTaunts(C)).toEqual([DEFAULT_TAUNT]);
    });

    it('refuses a blank line or a duplicate', async () => {
      await expect(svc.addImageTaunt(A, '   ')).rejects.toBeInstanceOf(FloofError);
      await expect(svc.addImageTaunt(A, DEFAULT_TAUNT)).rejects.toBeInstanceOf(FloofError);
      // Case-insensitive, so the same line cannot sneak in twice.
      await expect(svc.addImageTaunt(A, '!PET ME')).rejects.toBeInstanceOf(FloofError);
    });

    it('lets a floof be made completely silent', async () => {
      // An emptied list must PERSIST as empty rather than reverting to the default,
      // or a deliberately quiet floof would start talking again.
      await svc.removeImageTaunt(A, DEFAULT_TAUNT);
      expect(svc.getImageTaunts(A)).toEqual([]);
      const fresh = new FloofService({ prisma } as unknown as Storage, logger);
      await fresh.init();
      expect(fresh.getImageTaunts(A)).toEqual([]);
    });

    it('remembers lines across a restart', async () => {
      await svc.addImageTaunt(A, 'scritches please');
      const fresh = new FloofService({ prisma } as unknown as Storage, logger);
      await fresh.init();
      expect(fresh.getImageTaunts(A)).toEqual([DEFAULT_TAUNT, 'scritches please']);
    });

    it('forgets a deleted floof’s lines, so a re-upload starts clean', async () => {
      await svc.addImageTaunt(A, 'remember me');
      await svc.deleteImage(A);
      await writeFile(path.join(FLOOF_DIR, A), squarePng());
      expect(svc.getImageTaunts(A)).toEqual([DEFAULT_TAUNT]);
    });

    it('hands the spawning floof its OWN lines', async () => {
      await svc.setImageTaunts(A, ['only A says this']);
      for (const s2 of FLOOF_STYLES) await svc.setImageStyle(B, s2, false);
      for (const s2 of FLOOF_STYLES) await svc.setImageStyle(C, s2, false);
      const got = await svc.pickSpawn(A);
      expect(got.image.taunts).toEqual(['only A says this']);
    });

    it('migrates a pre-existing shared list onto every photo', async () => {
      // Upgrading must not silently discard taunts the broadcaster configured.
      await prisma.setting.deleteMany({ where: { key: 'floof.imageTaunts' } });
      await prisma.setting.upsert({
        where: { key: 'floof.taunts' },
        create: { key: 'floof.taunts', value: JSON.stringify(['old one', 'old two']) },
        update: { value: JSON.stringify(['old one', 'old two']) },
      });
      const migrated = new FloofService({ prisma } as unknown as Storage, logger);
      await migrated.init();
      expect(migrated.getImageTaunts(A)).toEqual(['old one', 'old two']);
      expect(migrated.getImageTaunts(B)).toEqual(['old one', 'old two']);

      // ...and only once: later edits are not clobbered on the next boot.
      await migrated.setImageTaunts(A, ['edited']);
      const again = new FloofService({ prisma } as unknown as Storage, logger);
      await again.init();
      expect(again.getImageTaunts(A)).toEqual(['edited']);
    });
  });

  it('clamps fractional animation settings without rounding them away', async () => {
    const cfg = await svc.setConfig({ hopSeconds: 0.35, ghostFadeSeconds: 99, peekDelaySeconds: -4 });
    expect(cfg.hopSeconds).toBe(0.35);
    expect(cfg.ghostFadeSeconds).toBe(5); // clamped to the max
    expect(cfg.peekDelaySeconds).toBe(0); // clamped to the min
  });
});
