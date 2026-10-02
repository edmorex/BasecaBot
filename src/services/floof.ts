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

/** The movement styles a floof can spawn with. */
export const FLOOF_STYLES = ['pingpong', 'roll', 'hop', 'peek', 'ghost'] as const;
export type FloofStyle = (typeof FLOOF_STYLES)[number];

/** Human labels for the admin panel and chat messages. */
export const FLOOF_STYLE_LABELS: Record<FloofStyle, string> = {
  pingpong: 'Ping Pong',
  roll: 'Roll',
  hop: 'Hop',
  peek: 'Peek',
  ghost: 'Ghost',
};

export function isFloofStyle(v: unknown): v is FloofStyle {
  return (FLOOF_STYLES as readonly string[]).includes(String(v));
}

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
  /** Ping Pong drift speed, 1 (slow) … 10 (fast). */
  speed: number;
  /** Ping Pong: how far the floof wags as it drifts, in degrees. */
  pingpongWagDegrees: number;
  /** Ping Pong: seconds for one full wag cycle. */
  pingpongWagSeconds: number;
  /** Roll: how fast it trundles along the floor, 1 … 10. */
  rollSpeed: number;
  /** Hop: horizontal distance covered by one hop, in pixels. */
  hopDistance: number;
  /** Hop: peak height of the arc, in pixels. */
  hopHeight: number;
  /** Hop: seconds spent in the air per hop. */
  hopSeconds: number;
  /** Hop: seconds sat still between hops. */
  hopDelaySeconds: number;
  /** Peek: how far it rises above the bottom edge, in pixels. */
  peekHeight: number;
  /** Peek: seconds to slide up (and to slide back down). */
  peekRiseSeconds: number;
  /** Peek: seconds spent peeking before it ducks away. */
  peekHoldSeconds: number;
  /** Peek: seconds hidden before it pops up somewhere else. */
  peekDelaySeconds: number;
  /** Peek: how far it wags while watching, in degrees. */
  peekWagDegrees: number;
  /** Peek: seconds for one full wag cycle. */
  peekWagSeconds: number;
  /** Ghost: seconds to fade in (and to fade back out). */
  ghostFadeSeconds: number;
  /** Ghost: seconds held at full opacity. */
  ghostHoldSeconds: number;
  /** Ghost: seconds invisible before reappearing elsewhere. */
  ghostDelaySeconds: number;
  /** Ghost: how far it wags, in degrees. */
  ghostWagDegrees: number;
  /** Ghost: seconds for one full wag cycle. */
  ghostWagSeconds: number;
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
  pingpongWagDegrees: 9,
  pingpongWagSeconds: 0.63,
  rollSpeed: 5,
  hopDistance: 220,
  hopHeight: 120,
  hopSeconds: 0.7,
  hopDelaySeconds: 0.5,
  peekHeight: 96,
  peekRiseSeconds: 0.5,
  peekHoldSeconds: 2.5,
  peekDelaySeconds: 0.8,
  peekWagDegrees: 5,
  peekWagSeconds: 0.63,
  ghostFadeSeconds: 1.2,
  ghostHoldSeconds: 1.6,
  ghostDelaySeconds: 0.6,
  ghostWagDegrees: 12,
  ghostWagSeconds: 1.4,
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
  pingpongWagDegrees: [0, 45],
  pingpongWagSeconds: [0.2, 5],
  rollSpeed: [1, 10],
  hopDistance: [40, 1200],
  hopHeight: [10, 600],
  hopSeconds: [0.2, 3],
  hopDelaySeconds: [0, 5],
  peekHeight: [16, 400],
  peekRiseSeconds: [0.1, 3],
  peekHoldSeconds: [0.2, 15],
  peekDelaySeconds: [0, 10],
  peekWagDegrees: [0, 45],
  peekWagSeconds: [0.2, 5],
  ghostFadeSeconds: [0.2, 5],
  ghostHoldSeconds: [0.2, 10],
  ghostDelaySeconds: [0, 10],
  ghostWagDegrees: [0, 45],
  ghostWagSeconds: [0.2, 5],
  padLeft: [0, 800],
  padRight: [0, 800],
  padTop: [0, 200],
  padBottom: [0, 200],
};

/** Settings that are meaningful as fractions of a second; the rest are rounded. */
const FRACTIONAL = new Set([
  'pingpongWagSeconds', 'peekWagSeconds', 'hopSeconds', 'hopDelaySeconds', 'peekRiseSeconds', 'peekHoldSeconds', 'peekDelaySeconds',
  'ghostFadeSeconds', 'ghostHoldSeconds', 'ghostDelaySeconds', 'ghostWagSeconds',
]);

/** Chat-facing setter names -> config keys (`!pet set <variable> <value>`). */
export const FLOOF_VARIABLES: Record<string, keyof FloofConfig> = {
  enabled: 'enabled',
  base: 'baseSeconds',
  random: 'randomSeconds',
  despawn: 'despawnSeconds',
  speed: 'speed',
  'pingpong-wag': 'pingpongWagDegrees',
  'pingpong-wag-seconds': 'pingpongWagSeconds',
  'roll-speed': 'rollSpeed',
  'hop-distance': 'hopDistance',
  'hop-height': 'hopHeight',
  'hop-seconds': 'hopSeconds',
  'hop-delay': 'hopDelaySeconds',
  'peek-height': 'peekHeight',
  'peek-rise': 'peekRiseSeconds',
  'peek-hold': 'peekHoldSeconds',
  'peek-delay': 'peekDelaySeconds',
  'peek-wag': 'peekWagDegrees',
  'peek-wag-seconds': 'peekWagSeconds',
  'ghost-fade': 'ghostFadeSeconds',
  'ghost-hold': 'ghostHoldSeconds',
  'ghost-delay': 'ghostDelaySeconds',
  'ghost-wag': 'ghostWagDegrees',
  'ghost-wag-seconds': 'ghostWagSeconds',
  'pad-left': 'padLeft',
  'pad-right': 'padRight',
  'pad-top': 'padTop',
  'pad-bottom': 'padBottom',
};

export interface FloofImage {
  name: string;
  url: string;
  bytes: number;
  /** Movement styles this photo is allowed to spawn with (all of them by default). */
  styles: FloofStyle[];
  /** This photo's own speech-bubble lines. */
  taunts: string[];
  /** The floof's name, or '' when it has not been named. */
  label: string;
  /** What to call it in chat: its name, or the stand-in for an unnamed floof. */
  displayName: string;
}

/** What a newly-added floof starts with; each photo's list is edited separately. */
export const DEFAULT_TAUNT = '!pet me';
/** Stands in for an unnamed floof wherever the game refers to one by name. */
export const DEFAULT_FLOOF_NAME = 'The floof';
/** Longest name accepted for a floof. */
export const MAX_FLOOF_NAME = 40;

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
  /** Per-photo speech-bubble lines. Absent means "never customised", which reads
   *  as the single default taunt; present-but-empty means a deliberately silent
   *  floof, so the two cases must stay distinguishable. */
  private imageTaunts = new Map<string, string[]>();
  /** Per-photo names. Absent or '' means the floof has not been named. */
  private imageNames = new Map<string, string>();
  /** Per-photo allowed movement styles. A photo absent from this map allows all
   *  of them, so uploading a floof needs no extra step. */
  private imageStyles = new Map<string, FloofStyle[]>();
  /** Set by the floof plugin; lets the admin panel trigger a spawn on demand. */
  private spawner?: (image: string | null, style: FloofStyle | null) => Promise<string | null>;
  /** Set by the floof plugin; stands in for a chatter's !pet without scoring it. */
  private petSimulator?: () => Promise<string | null>;

  constructor(
    private readonly storage: Storage,
    private readonly logger: Logger,
  ) {}

  private get db() {
    return this.storage.prisma;
  }

  /** Load persisted settings and make sure the image directory exists. */
  async init(): Promise<void> {
    // Taunts used to be one shared list. If this install still has that and no
    // per-photo lists yet, every existing photo inherits it — silently dropping a
    // configured set of taunts would be a nasty surprise on upgrade.
    let legacyShared: string[] | null = null;
    let hadPerImage = false;
    try {
      const rows = await this.db.setting.findMany({
        where: { key: { in: ['floof.config', 'floof.taunts', 'floof.imageStyles', 'floof.imageTaunts', 'floof.imageNames'] } },
      });
      for (const row of rows) {
        if (row.key === 'floof.config') {
          this.config = this.clamp({ ...FLOOF_DEFAULTS, ...(safeJson(row.value) as Partial<FloofConfig>) });
        } else if (row.key === 'floof.taunts') {
          const list = safeJson(row.value);
          if (Array.isArray(list)) legacyShared = cleanTaunts(list as unknown[]);
        } else if (row.key === 'floof.imageTaunts') {
          hadPerImage = true;
          const map = safeJson(row.value) as Record<string, unknown>;
          for (const [name, list] of Object.entries(map ?? {})) {
            if (Array.isArray(list)) this.imageTaunts.set(name, cleanTaunts(list));
          }
        } else if (row.key === 'floof.imageNames') {
          const map = safeJson(row.value) as Record<string, unknown>;
          for (const [file, label] of Object.entries(map ?? {})) {
            const clean = cleanFloofName(label);
            if (clean) this.imageNames.set(file, clean);
          }
        } else if (row.key === 'floof.imageStyles') {
          const map = safeJson(row.value) as Record<string, unknown>;
          for (const [name, list] of Object.entries(map ?? {})) {
            if (Array.isArray(list)) this.imageStyles.set(name, cleanStyles(list));
          }
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
    if (!hadPerImage && legacyShared && legacyShared.length) {
      try {
        const names = (await readdir(FLOOF_DIR)).filter((n) => n.toLowerCase().endsWith('.png'));
        for (const name of names) this.imageTaunts.set(name, [...legacyShared]);
        await this.saveImageTaunts(); // writing the key is what marks this done
        this.logger.info({ photos: names.length }, 'floof: migrated the shared taunt list onto each photo');
      } catch (err) {
        this.logger.warn({ err }, 'floof: could not migrate the shared taunt list');
      }
    }
  }

  /**
   * The plugin owns the round state machine, but the admin panel (which only has
   * this service) needs to fire a spawn. It registers its spawn function here.
   */
  setSpawner(fn: (image: string | null, style: FloofStyle | null) => Promise<string | null>): void {
    this.spawner = fn;
  }

  /**
   * Manually spawn a floof now. `image` and `style` may each be null for "pick at
   * random". Resolves to an error message, or null on success.
   */
  async requestSpawn(image: string | null = null, style: FloofStyle | null = null): Promise<string | null> {
    if (!this.spawner) return 'The floof game is not running.';
    return this.spawner(image, style);
  }

  /** Register the plugin's simulated-`!pet` hook. */
  setPetSimulator(fn: () => Promise<string | null>): void {
    this.petSimulator = fn;
  }

  /**
   * Stand in for a chatter typing `!pet`, for testing. Scores NOTHING — no win
   * recorded, no chat announcement, no achievement — so the broadcaster can step
   * trigger the win animation without polluting the scoreboard.
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
    const out = { ...FLOOF_DEFAULTS, enabled: !!c.enabled };
    for (const key of Object.keys(FLOOF_RANGES) as (keyof FloofConfig)[]) {
      const [lo, hi] = FLOOF_RANGES[key]!;
      const raw = Number(c[key]);
      const num = FRACTIONAL.has(key) ? Math.round(raw * 100) / 100 : Math.round(raw);
      (out[key] as number) = Number.isFinite(num) ? Math.min(hi, Math.max(lo, num)) : (FLOOF_DEFAULTS[key] as number);
    }
    return out;
  }

  // ── Names (per photo) ───────────────────────────────────────────────────────

  /** A photo's name as the broadcaster typed it, or '' if it has none. */
  getImageName(name: string): string {
    return this.imageNames.get(safeImageName(name)) ?? '';
  }

  /**
   * What the game should call this floof — its name, or the stand-in for an
   * unnamed one. Kept here so chat, the panel and the picker never disagree.
   */
  getImageDisplayName(name: string): string {
    return this.getImageName(name) || DEFAULT_FLOOF_NAME;
  }

  /** Name a photo, or clear its name by passing a blank string. */
  async setImageName(name: string, label: unknown): Promise<string> {
    const key = safeImageName(name);
    const clean = cleanFloofName(label);
    if (clean) this.imageNames.set(key, clean);
    else this.imageNames.delete(key);
    const obj: Record<string, string> = {};
    for (const [file, value] of this.imageNames) obj[file] = value;
    await this.saveSetting('floof.imageNames', JSON.stringify(obj));
    return clean;
  }

  // ── Taunts (per photo) ──────────────────────────────────────────────────────

  /** One photo's speech-bubble lines. A photo never customised gets the default. */
  getImageTaunts(name: string): string[] {
    const key = safeImageName(name);
    const own = this.imageTaunts.get(key);
    return own ? [...own] : [DEFAULT_TAUNT];
  }

  /** Replace one photo's list outright (trimmed, de-duplicated, capped). */
  async setImageTaunts(name: string, list: unknown[]): Promise<string[]> {
    const key = safeImageName(name);
    this.imageTaunts.set(key, cleanTaunts(list));
    await this.saveImageTaunts();
    return this.getImageTaunts(key);
  }

  async addImageTaunt(name: string, text: string): Promise<string[]> {
    const line = String(text ?? '').trim();
    if (!line) throw new FloofError('Enter a taunt first.');
    const current = this.getImageTaunts(name);
    if (current.some((t) => t.toLowerCase() === line.toLowerCase())) {
      throw new FloofError('That floof already says that.');
    }
    return this.setImageTaunts(name, [...current, line]);
  }

  async removeImageTaunt(name: string, text: string): Promise<string[]> {
    const line = String(text ?? '').trim().toLowerCase();
    // Persist the empty list rather than falling back to the default, so a floof
    // really can be made silent.
    return this.setImageTaunts(name, this.getImageTaunts(name).filter((t) => t.toLowerCase() !== line));
  }

  private async saveImageTaunts(): Promise<void> {
    const obj: Record<string, string[]> = {};
    for (const [name, list] of this.imageTaunts) obj[name] = list;
    await this.saveSetting('floof.imageTaunts', JSON.stringify(obj));
  }

  // ── Image library ───────────────────────────────────────────────────────────

  /** The movement styles a photo may spawn with (all of them unless narrowed). */
  getImageStyles(name: string): FloofStyle[] {
    return [...(this.imageStyles.get(safeImageName(name)) ?? FLOOF_STYLES)];
  }

  /**
   * Allow or forbid one style for one photo.
   *
   * A photo with NO styles left is simply never picked at random — which doubles
   * as a way to shelve a photo without deleting it. It can still be spawned
   * explicitly from the admin panel.
   */
  async setImageStyle(name: string, style: string, on: boolean): Promise<FloofStyle[]> {
    if (!isFloofStyle(style)) throw new FloofError(`"${style}" is not a floof animation style.`);
    const key = safeImageName(name);
    const set = new Set(this.getImageStyles(key));
    if (on) set.add(style);
    else set.delete(style);
    const list = cleanStyles([...set]);
    this.imageStyles.set(key, list);
    await this.saveImageStyles();
    return list;
  }

  private async saveImageStyles(): Promise<void> {
    const obj: Record<string, FloofStyle[]> = {};
    for (const [name, list] of this.imageStyles) obj[name] = list;
    await this.saveSetting('floof.imageStyles', JSON.stringify(obj));
  }

  /** Every PNG currently available to the game. */
  async listImages(): Promise<FloofImage[]> {
    try {
      const names = (await readdir(FLOOF_DIR)).filter((n) => n.toLowerCase().endsWith('.png'));
      const out: FloofImage[] = [];
      for (const name of names.sort()) {
        try {
          const buf = await readFile(path.join(FLOOF_DIR, name));
          out.push({
            name, url: FLOOF_URL + name, bytes: buf.length,
            styles: this.getImageStyles(name), taunts: this.getImageTaunts(name),
            label: this.getImageName(name), displayName: this.getImageDisplayName(name),
          });
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
   * Choose what to spawn. Either argument may be null for "surprise me"; a photo
   * and a style are picked together so the pair is always one the admin allowed.
   *
   * An explicit request is honoured even if that photo has the style switched off
   * — the admin asked for it by name, which only happens when testing.
   */
  async pickSpawn(
    imageName: string | null = null,
    style: FloofStyle | null = null,
  ): Promise<{ image: FloofImage; style: FloofStyle }> {
    const images = await this.listImages();
    if (!images.length) throw new FloofError('No floof photos have been uploaded yet.');

    if (imageName) {
      const wanted = safeImageName(imageName);
      const found = images.find((i) => i.name === wanted);
      if (!found) throw new FloofError(`There is no floof photo called "${wanted}".`);
      return { image: found, style: style ?? randomOf(found.styles) ?? 'pingpong' };
    }

    // Only photos that allow the requested style (or allow anything at all).
    const pool = images.filter((i) => (style ? i.styles.includes(style) : i.styles.length > 0));
    if (!pool.length) {
      throw new FloofError(
        style
          ? `No floof photos have the ${FLOOF_STYLE_LABELS[style]} animation enabled.`
          : 'Every floof photo has all of its animations switched off.',
      );
    }
    const image = randomOf(pool)!;
    return { image, style: style ?? randomOf(image.styles)! };
  }

  /**
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
    return {
      name, url: FLOOF_URL + name, bytes: buf.length,
      styles: this.getImageStyles(name), taunts: this.getImageTaunts(name),
      label: this.getImageName(name), displayName: this.getImageDisplayName(name),
    };
  }

  /** Delete an image by name (path-traversal safe). */
  async deleteImage(rawName: string): Promise<void> {
    const name = safeImageName(rawName);
    try {
      await unlink(path.join(FLOOF_DIR, name));
      if (this.imageStyles.delete(name)) await this.saveImageStyles();
      if (this.imageTaunts.delete(name)) await this.saveImageTaunts();
      if (this.imageNames.has(name)) await this.setImageName(name, '');
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

/** Trim a floof's name; blank means unnamed. */
function cleanFloofName(raw: unknown): string {
  return String(raw ?? '').trim().replace(/\s+/g, ' ').slice(0, MAX_FLOOF_NAME);
}

/** Trim a style list to the known styles, de-duplicated and in canonical order. */
function cleanStyles(list: unknown[]): FloofStyle[] {
  const set = new Set(list.map(String).filter(isFloofStyle));
  return FLOOF_STYLES.filter((s) => set.has(s));
}

function randomOf<T>(list: readonly T[]): T | undefined {
  return list.length ? list[Math.floor(Math.random() * list.length)] : undefined;
}

function safeJson(s: string): unknown {
  try {
    const o = JSON.parse(s) as unknown;
    return o && typeof o === 'object' ? o : {};
  } catch {
    return {};
  }
}
