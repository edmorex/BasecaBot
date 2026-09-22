import { readdir, readFile, writeFile, unlink, mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { Storage } from './storage/index.js';
import type { Logger } from './logger.js';

/** Where uploaded floof PNGs live (bind-mounted in production — see docs). */
export const FLOOF_DIR = path.resolve('public', 'assets', 'floofs');
/** Public URL prefix the overlay loads images from. */
export const FLOOF_URL = '/assets/floofs/';
/** Largest upload accepted, in bytes. */
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

/** Tunable game settings (persisted in the Setting table as one JSON blob). */
export interface FloofConfig {
  /** Master switch: when off, the timer never spawns (manual fire still works). */
  enabled: boolean;
  /** Base seconds between spawns. */
  baseSeconds: number;
  /** Extra random seconds added on top of the base each cycle. */
  randomSeconds: number;
  /** How long an un-pet floof stays before giving up. */
  despawnSeconds: number;
  /** Animation speed, 1 (slow) … 10 (fast). */
  speed: number;
  /** Boss battle: how many chatters must !pet to defeat it. */
  bossPets: number;
  /** Boss battle: percent chance a scheduled spawn is a boss instead. */
  bossChance: number;
  /** Boss battle: seconds before the boss escapes (usually longer than normal). */
  bossDespawnSeconds: number;
  padLeft: number;
  padRight: number;
  padTop: number;
  padBottom: number;
}

export const FLOOF_DEFAULTS: FloofConfig = {
  enabled: false,
  baseSeconds: 960, // 16 min
  randomSeconds: 480, // + up to 8 min
  despawnSeconds: 120,
  speed: 5,
  bossPets: 20,
  bossChance: 10,
  bossDespawnSeconds: 180,
  padLeft: 0,
  padRight: 0,
  padTop: 0,
  padBottom: 0,
};

/** [min, max] bounds for each numeric setting. */
export const FLOOF_RANGES: Record<string, readonly [number, number]> = {
  baseSeconds: [10, 86400],
  randomSeconds: [0, 86400],
  despawnSeconds: [5, 3600],
  speed: [1, 10],
  bossPets: [1, 500],
  bossChance: [0, 100],
  bossDespawnSeconds: [10, 3600],
  padLeft: [0, 800],
  padRight: [0, 800],
  padTop: [0, 200],
  padBottom: [0, 200],
};

/** Chat-facing setter names -> config keys (`!pet set <variable> <value>`). */
export const FLOOF_VARIABLES: Record<string, keyof FloofConfig> = {
  enabled: 'enabled',
  base: 'baseSeconds',
  random: 'randomSeconds',
  despawn: 'despawnSeconds',
  speed: 'speed',
  'boss-pets': 'bossPets',
  'boss-chance': 'bossChance',
  'boss-despawn': 'bossDespawnSeconds',
  'pad-left': 'padLeft',
  'pad-right': 'padRight',
  'pad-top': 'padTop',
  'pad-bottom': 'padBottom',
};

export interface FloofImage {
  name: string;
  url: string;
  bytes: number;
  /** True when this photo is reserved for Boss Floof battles. */
  boss: boolean;
}

/** The taunts shipped out of the box; the admin panel can edit the list freely. */
export const DEFAULT_TAUNTS = ['!pet me', 'i can haz !pet?', 'i wants !pet'];

export interface FloofStatView {
  wins: number;
  /** 1-based rank among all winners, or null if they've never won. */
  rank: number | null;
  lastWonAt: Date | null;
}

/** A PNG's dimensions read straight from the IHDR chunk, or null if not a PNG. */
export function readPngSize(buf: Buffer): { width: number; height: number } | null {
  const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buf.length < 24 || !buf.subarray(0, 8).equals(SIG)) return null;
  if (buf.subarray(12, 16).toString('ascii') !== 'IHDR') return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/**
 * Reduce an uploaded filename to something safe to write + serve: drop any path,
 * scrub to the charset the asset route allows, and force a single `.png`.
 * Leading dots are stripped from the STEM (not the finished name) so a hostile
 * "..." can't end up as a bare, extension-less file the server won't serve.
 */
export function safeImageName(raw: string): string {
  const base = path.basename(String(raw ?? '')).replace(/[^a-zA-Z0-9._-]/g, '_');
  const stem = base.toLowerCase().endsWith('.png') ? base.slice(0, -4) : base;
  const clean = stem.replace(/^[._-]+/, '') || 'floof';
  return `${clean}.png`;
}

/**
 * "Pet the Floof" — settings, the image library, and the win scoreboard.
 *
 * Config is persisted as one JSON blob in the Setting table (same approach as the
 * TTS voice settings) and clamped on write, so a bad value from chat or the admin
 * panel can never put the game into an impossible state. Images are plain PNG
 * files on disk under `public/assets/floofs` — bind-mounted in production so
 * uploads survive a redeploy.
 *
 * The round/state machine itself lives in the floof plugin; this service is the
 * persistence + validation layer.
 */
export class FloofService {
  private config: FloofConfig = { ...FLOOF_DEFAULTS };
  private taunts: string[] = [...DEFAULT_TAUNTS];
  /** Image filenames flagged as Boss-only (stored as a Setting, not a directory,
   *  so bosses share the one bind-mounted folder). */
  private bossImages = new Set<string>();
  /** Set by the floof plugin; lets the admin panel trigger a spawn on demand. */
  private spawner?: () => Promise<string | null>;
  /** Set by the floof plugin; stands in for a chatter's !pet without scoring it. */
  private petSimulator?: () => Promise<string | null>;
  /** Set by the floof plugin; spawns a Boss Floof battle on demand. */
  private bossSpawner?: () => Promise<string | null>;

  constructor(
    private readonly storage: Storage,
    private readonly logger: Logger,
  ) {}

  private get db() {
    return this.storage.prisma;
  }

  /** Load persisted settings and make sure the image directory exists. */
  async init(): Promise<void> {
    try {
      const rows = await this.db.setting.findMany({
        where: { key: { in: ['floof.config', 'floof.taunts', 'floof.bossImages'] } },
      });
      for (const row of rows) {
        if (row.key === 'floof.config') {
          this.config = this.clamp({ ...FLOOF_DEFAULTS, ...(safeJson(row.value) as Partial<FloofConfig>) });
        } else if (row.key === 'floof.taunts') {
          const list = safeJson(row.value);
          if (Array.isArray(list)) this.taunts = cleanTaunts(list as unknown[]);
        } else if (row.key === 'floof.bossImages') {
          const list = safeJson(row.value);
          if (Array.isArray(list)) this.bossImages = new Set((list as unknown[]).map(String));
        }
      }
    } catch (err) {
      this.logger.warn({ err }, 'floof: could not load settings');
    }
    try {
      await mkdir(FLOOF_DIR, { recursive: true });
    } catch (err) {
      this.logger.warn({ err, dir: FLOOF_DIR }, 'floof: could not create image directory');
    }
  }

  /**
   * The plugin owns the round state machine, but the admin panel (which only has
   * this service) needs to fire a spawn. It registers its spawn function here.
   */
  setSpawner(fn: () => Promise<string | null>): void {
    this.spawner = fn;
  }

  /** Manually spawn a floof now. Resolves to an error message, or null on success. */
  async requestSpawn(): Promise<string | null> {
    if (!this.spawner) return 'The floof game is not running.';
    return this.spawner();
  }

  /** Register the plugin's boss-spawn hook. */
  setBossSpawner(fn: () => Promise<string | null>): void {
    this.bossSpawner = fn;
  }

  /** Start a Boss Floof battle now. Resolves to an error message, or null. */
  async requestBossSpawn(): Promise<string | null> {
    if (!this.bossSpawner) return 'The floof game is not running.';
    return this.bossSpawner();
  }

  /** Register the plugin's simulated-`!pet` hook. */
  setPetSimulator(fn: () => Promise<string | null>): void {
    this.petSimulator = fn;
  }

  /**
   * Stand in for a chatter typing `!pet`, for testing. Scores NOTHING — no win
   * recorded, no chat announcement, no achievement — so the broadcaster can step
   * through a boss battle or trigger the win animation without polluting the
   * scoreboard.
   */
  async requestSimulatedPet(): Promise<string | null> {
    if (!this.petSimulator) return 'The floof game is not running.';
    return this.petSimulator();
  }

  getConfig(): FloofConfig {
    return { ...this.config };
  }

  get defaults(): FloofConfig {
    return { ...FLOOF_DEFAULTS };
  }

  /** Merge + clamp a partial update, persist it, and return the new config. */
  async setConfig(partial: Partial<FloofConfig>): Promise<FloofConfig> {
    this.config = this.clamp({ ...this.config, ...partial });
    await this.saveSetting('floof.config', JSON.stringify(this.config));
    return this.getConfig();
  }

  private async saveSetting(key: string, value: string): Promise<void> {
    await this.db.setting.upsert({ where: { key }, create: { key, value }, update: { value } });
  }

  private clamp(c: FloofConfig): FloofConfig {
    const n = (v: unknown, key: string, fallback: number) => {
      const [lo, hi] = FLOOF_RANGES[key]!;
      const num = Math.round(Number(v));
      return Number.isFinite(num) ? Math.min(hi, Math.max(lo, num)) : fallback;
    };
    return {
      enabled: !!c.enabled,
      baseSeconds: n(c.baseSeconds, 'baseSeconds', FLOOF_DEFAULTS.baseSeconds),
      randomSeconds: n(c.randomSeconds, 'randomSeconds', FLOOF_DEFAULTS.randomSeconds),
      despawnSeconds: n(c.despawnSeconds, 'despawnSeconds', FLOOF_DEFAULTS.despawnSeconds),
      speed: n(c.speed, 'speed', FLOOF_DEFAULTS.speed),
      bossPets: n(c.bossPets, 'bossPets', FLOOF_DEFAULTS.bossPets),
      bossChance: n(c.bossChance, 'bossChance', FLOOF_DEFAULTS.bossChance),
      bossDespawnSeconds: n(c.bossDespawnSeconds, 'bossDespawnSeconds', FLOOF_DEFAULTS.bossDespawnSeconds),
      padLeft: n(c.padLeft, 'padLeft', 0),
      padRight: n(c.padRight, 'padRight', 0),
      padTop: n(c.padTop, 'padTop', 0),
      padBottom: n(c.padBottom, 'padBottom', 0),
    };
  }

  // ── Taunts ──────────────────────────────────────────────────────────────────

  /** The speech-bubble lines the overlay picks from. Never empty. */
  getTaunts(): string[] {
    return this.taunts.length ? [...this.taunts] : [...DEFAULT_TAUNTS];
  }

  /** Replace the whole list (trimmed, de-duplicated, capped). */
  async setTaunts(list: unknown[]): Promise<string[]> {
    this.taunts = cleanTaunts(list);
    await this.saveSetting('floof.taunts', JSON.stringify(this.taunts));
    return this.getTaunts();
  }

  async addTaunt(text: string): Promise<string[]> {
    const line = String(text ?? '').trim();
    if (!line) throw new FloofError('Enter a taunt first.');
    if (this.taunts.some((t) => t.toLowerCase() === line.toLowerCase())) throw new FloofError('That taunt is already in the list.');
    return this.setTaunts([...this.taunts, line]);
  }

  async removeTaunt(text: string): Promise<string[]> {
    const line = String(text ?? '').trim().toLowerCase();
    return this.setTaunts(this.taunts.filter((t) => t.toLowerCase() !== line));
  }

  // ── Image library ───────────────────────────────────────────────────────────

  /** Whether an image is reserved for Boss Floof battles. */
  isBossImage(name: string): boolean {
    return this.bossImages.has(safeImageName(name));
  }

  /** Flag/unflag an image as boss-only. */
  async setBossImage(name: string, boss: boolean): Promise<void> {
    const key = safeImageName(name);
    if (boss) this.bossImages.add(key);
    else this.bossImages.delete(key);
    await this.saveSetting('floof.bossImages', JSON.stringify([...this.bossImages]));
  }

  /** Every PNG currently available to the game. */
  async listImages(): Promise<FloofImage[]> {
    try {
      const names = (await readdir(FLOOF_DIR)).filter((n) => n.toLowerCase().endsWith('.png'));
      const out: FloofImage[] = [];
      for (const name of names.sort()) {
        try {
          const buf = await readFile(path.join(FLOOF_DIR, name));
          out.push({ name, url: FLOOF_URL + name, bytes: buf.length, boss: this.bossImages.has(name) });
        } catch {
          // skip unreadable file
        }
      }
      return out;
    } catch {
      return []; // directory missing (e.g. bind mount not set up yet)
    }
  }

  /**
   * One random image from the requested pool — boss photos are kept separate from
   * normal ones, so a boss battle never shows an ordinary floof (or vice versa).
   */
  async randomImage(boss = false): Promise<FloofImage | null> {
    const pool = (await this.listImages()).filter((i) => i.boss === boss);
    return pool.length ? pool[Math.floor(Math.random() * pool.length)]! : null;
  }

  /**
   * Store an uploaded PNG. Rejects anything that isn't a real PNG or isn't
   * square — validated from the file's own IHDR header, no image library needed.
   */
  async saveImage(rawName: string, buf: Buffer): Promise<FloofImage> {
    if (buf.length === 0) throw new FloofError('That file is empty.');
    if (buf.length > MAX_IMAGE_BYTES) throw new FloofError(`Image is too large (max ${Math.floor(MAX_IMAGE_BYTES / 1024 / 1024)}MB).`);
    const size = readPngSize(buf);
    if (!size) throw new FloofError('That file is not a PNG.');
    if (size.width !== size.height) throw new FloofError(`Floof images must be square (this one is ${size.width}×${size.height}).`);

    const name = safeImageName(rawName);
    await mkdir(FLOOF_DIR, { recursive: true });
    await writeFile(path.join(FLOOF_DIR, name), buf);
    this.logger.info({ name, bytes: buf.length, size: size.width }, 'floof: image uploaded');
    return { name, url: FLOOF_URL + name, bytes: buf.length, boss: this.bossImages.has(name) };
  }

  /** Delete an image by name (path-traversal safe). */
  async deleteImage(rawName: string): Promise<void> {
    const name = safeImageName(rawName);
    try {
      await unlink(path.join(FLOOF_DIR, name));
      if (this.bossImages.delete(name)) await this.saveSetting('floof.bossImages', JSON.stringify([...this.bossImages]));
      this.logger.info({ name }, 'floof: image deleted');
    } catch {
      throw new FloofError(`No image called "${name}".`);
    }
  }

  // ── Scoreboard ──────────────────────────────────────────────────────────────

  /** Record a win (first to !pet). Returns the player's new total. */
  async recordWin(userId: string): Promise<number> {
    const row = await this.db.floofStat.upsert({
      where: { userId },
      create: { userId, wins: 1, lastWonAt: new Date() },
      update: { wins: { increment: 1 }, lastWonAt: new Date() },
    });
    return row.wins;
  }

  /**
   * Credit everyone who joined a winning boss battle. Returns how many rows were
   * touched. Boss wins are counted separately from solo wins.
   */
  async recordBossWin(userIds: string[]): Promise<number> {
    let n = 0;
    for (const userId of userIds) {
      try {
        await this.db.floofStat.upsert({
          where: { userId },
          create: { userId, bossWins: 1, lastWonAt: new Date() },
          update: { bossWins: { increment: 1 }, lastWonAt: new Date() },
        });
        n++;
      } catch (err) {
        this.logger.error({ err, userId }, 'floof: could not record boss win');
      }
    }
    return n;
  }

  /** A player's wins plus their rank among all winners. */
  async statsFor(userId: string): Promise<FloofStatView> {
    const row = await this.db.floofStat.findUnique({ where: { userId } });
    if (!row || row.wins === 0) return { wins: 0, rank: null, lastWonAt: null };
    const ahead = await this.db.floofStat.count({ where: { wins: { gt: row.wins } } });
    return { wins: row.wins, rank: ahead + 1, lastWonAt: row.lastWonAt };
  }

  /** Leaderboard rows, highest first. */
  async topWins(limit = 10): Promise<{ displayName: string; wins: number }[]> {
    const rows = await this.db.floofStat.findMany({
      where: { wins: { gt: 0 } },
      orderBy: { wins: 'desc' },
      take: limit,
      include: { user: { select: { displayName: true } } },
    });
    return rows.map((r) => ({ displayName: r.user.displayName, wins: r.wins }));
  }
}

/** A user-facing problem (bad upload, missing image); safe to show in chat/UI. */
export class FloofError extends Error {}

/** Trim, drop blanks/dupes, and cap the taunt list to something sane. */
function cleanTaunts(list: unknown[]): string[] {
  const out: string[] = [];
  for (const raw of list) {
    const line = String(raw ?? '').trim().slice(0, 120);
    if (line && !out.some((t) => t.toLowerCase() === line.toLowerCase())) out.push(line);
    if (out.length >= 50) break;
  }
  return out;
}

function safeJson(s: string): unknown {
  try {
    const o = JSON.parse(s) as unknown;
    return o && typeof o === 'object' ? o : {};
  } catch {
    return {};
  }
}
