import { readdir, readFile, writeFile, unlink, mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { Storage } from './storage/index.js';
import type { Logger } from './logger.js';
import { readPngSize } from './floof.js';

/** Where uploaded silhouette PNGs live (bind-mounted in production — see docs). */
export const CROWD_DIR = path.resolve('public', 'assets', 'crowd');
/** Public URL prefix the overlay loads silhouettes from. */
export const CROWD_URL = '/assets/crowd/';
/** Largest silhouette accepted, in bytes. */
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
/** Excitement runs level 1 (calm) to level 5 (hype). */
export const LEVELS = 5;

/** How a silhouette may be mirrored horizontally. */
export const MIRROR_MODES = ['off', 'move', 'position'] as const;
export type MirrorMode = (typeof MIRROR_MODES)[number];

/** The crowd's movement at one excitement level. */
export interface CrowdLevelAnim {
  /** Peak hop height in pixels. 0 keeps them on the floor. */
  jumpPx: number;
  /** Hops per second. */
  bounceHz: number;
  /** How far they rock either side, in degrees. */
  swayDeg: number;
  /** Random twitch, in pixels. */
  jitterPx: number;
  /** How far they wander left and right, in pixels. Neighbours may overlap. */
  driftPx: number;
}

/** Everything the overlay's look is driven by (persisted as one JSON blob). */
export interface CrowdConfig {
  /** Master switch. When off the overlay draws nothing, whatever chat does. */
  enabled: boolean;

  // ── Layout ──
  /** How many rows of silhouettes. */
  rows: number;
  /** Pixels each row sits above the one in front of it. */
  rowSpacing: number;
  /** Silhouettes per row. */
  perRow: number;
  /** Size multiplier applied per row back, faking distance. */
  rowScale: number;
  /** Front-row silhouette height, in pixels. */
  silhouetteHeight: number;
  /** Diameter of the profile picture, in pixels. */
  avatarSize: number;
  /** How long a chatter is pinned to a row before they may be moved. */
  rowDebounceSeconds: number;
  /** Back-light strength, 0 to disable. */
  glow: number;
  /** Back-light colour, as #rrggbb. */
  glowColor: string;
  /**
   * Whether to mirror a silhouette, and on what:
   *   'off'      - always the uploaded artwork
   *   'move'     - mirrored while drifting right, as-uploaded while drifting left
   *   'position' - mirrored on the left half of the screen, as-uploaded on the right
   */
  mirrorMode: MirrorMode;

  // ── Excitement ──
  /** Seconds of chat the rate is measured over. */
  rateWindowSeconds: number;
  /**
   * How many silent rate windows a chatter survives before being despawned. With
   * the defaults (6s window, 50) one message keeps them on screen for 5 minutes —
   * though busier chatters can still displace them once the rows are full.
   */
  survivalWindows: number;
  /** Messages+emotes per second needed to reach each level (ascending, 5 entries). */
  thresholds: number[];
  /** Movement per excitement level (5 entries). */
  levels: CrowdLevelAnim[];
  /** Movement while the broadcaster has forced Slow Mode. */
  calm: CrowdLevelAnim;
  /**
   * Seconds to travel one excitement level. The crowd eases between levels rather
   * than snapping, and because it moves through the levels one at a time it can
   * never skip one — a jump from calm to hype passes through everything between.
   */
  transitionSeconds: number;

  // ── Emote spew ──
  emoteSpew: boolean;
  /**
   * Regular-mode launch. An emote travels `spewDistance` pixels at `spewSpeed`
   * pixels per second, so it reaches the top of its arc after distance/speed
   * seconds and then floats and fades for the rest of `spewSeconds`. The two
   * variability values are the plus-or-minus each launch is randomised by, so a
   * speed of 260 with a variability of 30 fires between 230 and 290.
   */
  spewSpeed: number;
  spewSpeedVar: number;
  spewDistance: number;
  spewDistanceVar: number;
  /** Rendered emote size in pixels. */
  spewSize: number;
  /** Seconds a spewed emote is on screen before it has faded out. */
  spewSeconds: number;

  /** The same six values, used instead while the crowd is in slow mode. */
  spewSlowSpeed: number;
  spewSlowSpeedVar: number;
  spewSlowDistance: number;
  spewSlowDistanceVar: number;
  spewSlowSize: number;
  spewSlowSeconds: number;

  // ── Live-control defaults ──
  /** Seconds the overlay stays cleared and paused. */
  clearPauseSeconds: number;
  /** Seconds the crowd stays quiesced before it may ramp up again. */
  quiescePauseSeconds: number;
  /** Seconds the crowd stays in slow mode. */
  slowPauseSeconds: number;

  // ── Simulation ──
  simChatters: number;
  simChatRate: number;
  simEmoteRate: number;
}

const LEVEL_DEFAULTS: CrowdLevelAnim[] = [
  { jumpPx: 0, bounceHz: 0.5, swayDeg: 2, jitterPx: 0, driftPx: 4 },    // 1 — barely awake
  { jumpPx: 4, bounceHz: 1.0, swayDeg: 4, jitterPx: 1, driftPx: 14 },   // 2 — nodding along
  { jumpPx: 10, bounceHz: 1.6, swayDeg: 7, jitterPx: 2, driftPx: 28 },  // 3 — into it
  { jumpPx: 20, bounceHz: 2.3, swayDeg: 10, jitterPx: 3, driftPx: 46 }, // 4 — jumping, shoulders meeting
  { jumpPx: 34, bounceHz: 3.0, swayDeg: 14, jitterPx: 5, driftPx: 66 }, // 5 — hype, properly jostling
];

export const CROWD_DEFAULTS: CrowdConfig = {
  enabled: false,
  rows: 3,
  rowSpacing: 46,
  perRow: 6,
  rowScale: 0.86,
  silhouetteHeight: 190,
  avatarSize: 46,
  rowDebounceSeconds: 4,
  glow: 18,
  glowColor: '#ff6ec7',
  mirrorMode: 'off',
  rateWindowSeconds: 6,
  survivalWindows: 50,
  thresholds: [0, 0.5, 1.5, 3, 6],
  levels: LEVEL_DEFAULTS.map((l) => ({ ...l })),
  calm: { jumpPx: 0, bounceHz: 0.35, swayDeg: 6, jitterPx: 0, driftPx: 10 },
  transitionSeconds: 4,
  emoteSpew: true,
  spewSpeed: 260,
  spewSpeedVar: 30,
  spewDistance: 300,
  spewDistanceVar: 60,
  spewSize: 44,
  spewSeconds: 2.2,
  // Slow mode: a lazier, shorter lob that matches the gentle sway.
  spewSlowSpeed: 110,
  spewSlowSpeedVar: 15,
  spewSlowDistance: 140,
  spewSlowDistanceVar: 30,
  spewSlowSize: 40,
  spewSlowSeconds: 2.8,
  clearPauseSeconds: 30,
  quiescePauseSeconds: 30,
  slowPauseSeconds: 30,
  simChatters: 12,
  simChatRate: 2,
  simEmoteRate: 3,
};

/** The defaults, frozen once so the exported object cannot be edited by accident. */
const FROZEN_DEFAULTS: Readonly<CrowdConfig> = deepFreeze(cloneConfig(CROWD_DEFAULTS));

/** [min, max] bounds for the flat numeric settings. */
export const CROWD_RANGES: Record<string, readonly [number, number]> = {
  rows: [1, 8],
  rowSpacing: [0, 300],
  perRow: [2, 24],
  rowScale: [0.4, 1],
  silhouetteHeight: [40, 600],
  avatarSize: [8, 200],
  rowDebounceSeconds: [0, 60],
  glow: [0, 80],
  rateWindowSeconds: [1, 60],
  survivalWindows: [1, 1000],
  transitionSeconds: [0, 30],
  spewSpeed: [20, 1200],
  spewSpeedVar: [0, 600],
  spewDistance: [10, 2000],
  spewDistanceVar: [0, 1000],
  spewSize: [8, 200],
  spewSeconds: [0.3, 10],
  spewSlowSpeed: [20, 1200],
  spewSlowSpeedVar: [0, 600],
  spewSlowDistance: [10, 2000],
  spewSlowDistanceVar: [0, 1000],
  spewSlowSize: [8, 200],
  spewSlowSeconds: [0.3, 10],
  clearPauseSeconds: [0, 600],
  quiescePauseSeconds: [0, 600],
  slowPauseSeconds: [0, 600],
  simChatters: [1, 200],
  simChatRate: [0, 50],
  simEmoteRate: [0, 200],
};

/** [min, max] bounds for each per-level animation value. */
export const CROWD_ANIM_RANGES: Record<keyof CrowdLevelAnim, readonly [number, number]> = {
  jumpPx: [0, 300],
  bounceHz: [0, 12],
  swayDeg: [0, 45],
  jitterPx: [0, 60],
  driftPx: [0, 300],
};

/** Settings that are meaningful as fractions; the rest are rounded. */
const FRACTIONAL = new Set(['rowScale', 'spewSeconds', 'spewSlowSeconds', 'simChatRate', 'simEmoteRate', 'rateWindowSeconds', 'transitionSeconds']);
const FRACTIONAL_ANIM = new Set<keyof CrowdLevelAnim>(['bounceHz']);

/** Chat-facing setter names -> config keys. */
export const CROWD_VARIABLES: Record<string, keyof CrowdConfig> = {
  enabled: 'enabled',
  rows: 'rows',
  'row-spacing': 'rowSpacing',
  'per-row': 'perRow',
  'row-scale': 'rowScale',
  height: 'silhouetteHeight',
  'avatar-size': 'avatarSize',
  debounce: 'rowDebounceSeconds',
  glow: 'glow',
  'glow-color': 'glowColor',
  mirror: 'mirrorMode',
  window: 'rateWindowSeconds',
  survival: 'survivalWindows',
  transition: 'transitionSeconds',
  spew: 'emoteSpew',
  'spew-speed': 'spewSpeed',
  'spew-speed-var': 'spewSpeedVar',
  'spew-distance': 'spewDistance',
  'spew-distance-var': 'spewDistanceVar',
  'spew-size': 'spewSize',
  'spew-seconds': 'spewSeconds',
  'slow-spew-speed': 'spewSlowSpeed',
  'slow-spew-speed-var': 'spewSlowSpeedVar',
  'slow-spew-distance': 'spewSlowDistance',
  'slow-spew-distance-var': 'spewSlowDistanceVar',
  'slow-spew-size': 'spewSlowSize',
  'slow-spew-seconds': 'spewSlowSeconds',
};

export interface CrowdImage {
  name: string;
  url: string;
  bytes: number;
  width: number;
  height: number;
}

/**
 * A hold with no end, parked far enough in the future that the plugin's plain
 * `now < pausedUntil` checks need no special case. MAX_SAFE_INTEGER rather than
 * Infinity because this crosses JSON to the admin panel, and Infinity does not
 * survive the trip (it serialises to null).
 */
export const HOLD_FOREVER = Number.MAX_SAFE_INTEGER;

/** How the broadcaster is currently overriding the crowd. Not persisted. */
export interface CrowdLive {
  /**
   * 'slow' swaps every level for the calm animation values. Derived from
   * `slowUntil` rather than stored, so slow mode expires on its own the way the
   * clear and quiesce holds do.
   */
  mode: 'regular' | 'slow';
  /** Epoch ms until which the overlay takes no new updates. */
  pausedUntil: number;
  /** Epoch ms of the most recent clear request, so the plugin can act on a new one. */
  clearedAt: number;
  /** Epoch ms until which excitement is held at level 1. */
  quiescedUntil: number;
  /** Epoch ms until which the crowd stays in slow mode. */
  slowUntil: number;
  /** Whether synthetic chat is being generated. */
  sim: boolean;
  /** True when the hold runs until Resume rather than expiring. For display. */
  pausedForever: boolean;
  quiescedForever: boolean;
  slowForever: boolean;
}

/** A user-facing problem (bad upload); safe to show in the UI. */
export class CrowdError extends Error {}

/**
 * Which silhouette is pinned to which seat, keyed "row:slot".
 *
 * A seat with no entry is left on Random, meaning it draws a silhouette when it
 * next fills. Stale keys for rows or slots that no longer exist are harmless and
 * kept, so shrinking the layout and growing it again does not lose the work.
 */
export type SeatArt = Record<string, string>;
/** Most assignments kept, well past the largest possible grid (8 x 24). */
const MAX_SEAT_ART = 512;

/**
 * Crowd Hype — settings, the silhouette library, and the broadcaster's live
 * overrides.
 *
 * The live controls are deliberately plain state rather than callbacks into the
 * plugin: the plugin reads them on its own tick, so a control works the same
 * whether it was flipped from the panel, from chat, or while the plugin was
 * between ticks. Only the config is persisted — mode, pauses and the simulation
 * all start clean on a restart, which is what you want from a live override.
 */
export class CrowdHypeService {
  /**
   * The canonical config, deep-frozen.
   *
   * Handed to callers as-is rather than cloned per call: the plugin asks for it
   * on every tick and on every emote-bearing message, so a fresh copy each time
   * was pure garbage. Freezing is what makes sharing it safe — a caller that
   * tries to mutate it throws here (modules are strict mode) instead of quietly
   * corrupting the saved settings for everyone else.
   */
  private config: Readonly<CrowdConfig> = deepFreeze(cloneConfig(CROWD_DEFAULTS));
  private seatArt: SeatArt = {};
  private live = { pausedUntil: 0, clearedAt: 0, quiescedUntil: 0, slowUntil: 0, sim: false };

  constructor(
    private readonly storage: Storage,
    private readonly logger: Logger,
  ) {}

  private get db() {
    return this.storage.prisma;
  }

  async init(): Promise<void> {
    try {
      const rows = await this.db.setting.findMany({ where: { key: { in: ['crowd.config', 'crowd.seatArt'] } } });
      for (const row of rows) {
        if (row.key === 'crowd.config') {
          this.config = deepFreeze(this.clamp({ ...cloneConfig(CROWD_DEFAULTS), ...(safeJson(row.value) as Partial<CrowdConfig>) }));
        } else {
          this.seatArt = cleanSeatArt(safeJson(row.value));
        }
      }
    } catch (err) {
      this.logger.warn({ err }, 'crowd: could not load settings');
    }
    try {
      await mkdir(CROWD_DIR, { recursive: true });
    } catch (err) {
      this.logger.warn({ err, dir: CROWD_DIR }, 'crowd: could not create image directory');
    }
  }

  // ── Settings ────────────────────────────────────────────────────────────────

  /** The live settings. Frozen — treat it as read-only and clone if you must edit. */
  getConfig(): Readonly<CrowdConfig> {
    return this.config;
  }

  get defaults(): Readonly<CrowdConfig> {
    return FROZEN_DEFAULTS;
  }

  async setConfig(partial: Partial<CrowdConfig>): Promise<Readonly<CrowdConfig>> {
    this.config = deepFreeze(this.clamp({ ...this.config, ...partial }));
    await this.db.setting.upsert({
      where: { key: 'crowd.config' },
      create: { key: 'crowd.config', value: JSON.stringify(this.config) },
      update: { value: JSON.stringify(this.config) },
    });
    return this.config;
  }

  private clamp(c: Readonly<CrowdConfig>): CrowdConfig {
    const out = cloneConfig(CROWD_DEFAULTS);
    out.enabled = !!c.enabled;
    out.emoteSpew = !!c.emoteSpew;
    // A bad colour would make the glow filter invalid and drop it silently, so
    // anything that is not a plain hex triple falls back to the default.
    out.glowColor = /^#[0-9a-fA-F]{6}$/.test(String(c.glowColor))
      ? String(c.glowColor).toLowerCase()
      : CROWD_DEFAULTS.glowColor;
    out.mirrorMode = (MIRROR_MODES as readonly string[]).includes(String(c.mirrorMode))
      ? (String(c.mirrorMode) as MirrorMode)
      : CROWD_DEFAULTS.mirrorMode;
    for (const key of Object.keys(CROWD_RANGES) as (keyof CrowdConfig)[]) {
      const [lo, hi] = CROWD_RANGES[key]!;
      const raw = Number(c[key]);
      const num = FRACTIONAL.has(key) ? Math.round(raw * 100) / 100 : Math.round(raw);
      (out[key] as number) = Number.isFinite(num) ? Math.min(hi, Math.max(lo, num)) : (CROWD_DEFAULTS[key] as number);
    }
    // Thresholds are forced ascending: a level you could never reach because the
    // one above it is lower would just be a dead setting.
    const thresholds = Array.isArray(c.thresholds) ? c.thresholds : [];
    out.thresholds = [];
    let floor = 0;
    for (let i = 0; i < LEVELS; i++) {
      const fallback = CROWD_DEFAULTS.thresholds[i]!;
      const raw = Number(thresholds[i]);
      let v = Number.isFinite(raw) ? Math.max(0, Math.round(raw * 100) / 100) : fallback;
      if (i === 0) v = 0; // level 1 is where everyone starts
      if (v < floor) v = floor;
      out.thresholds.push(v);
      floor = v;
    }
    const levels = Array.isArray(c.levels) ? c.levels : [];
    out.levels = Array.from({ length: LEVELS }, (_, i) => clampAnim(levels[i], LEVEL_DEFAULTS[i]!));
    out.calm = clampAnim(c.calm, CROWD_DEFAULTS.calm);
    return out;
  }

  // ── Seat assignments ────────────────────────────────────────────────────────

  /** Which silhouette each seat is pinned to. Seats absent from this are Random. */
  getSeatArt(): SeatArt {
    return { ...this.seatArt };
  }

  /** Replace the whole set of assignments (a blank value means back to Random). */
  async setSeatArt(map: unknown): Promise<SeatArt> {
    this.seatArt = cleanSeatArt(map);
    await this.db.setting.upsert({
      where: { key: 'crowd.seatArt' },
      create: { key: 'crowd.seatArt', value: JSON.stringify(this.seatArt) },
      update: { value: JSON.stringify(this.seatArt) },
    });
    return this.getSeatArt();
  }

  /**
   * Seat assignments resolved to URLs, with anything pointing at a file that is
   * no longer there dropped — so a deleted silhouette degrades the seat to Random
   * rather than leaving it blank.
   */
  async resolveSeatArt(): Promise<Record<string, string>> {
    const have = new Set((await this.listImages()).map((i) => i.name));
    const out: Record<string, string> = {};
    for (const [seat, file] of Object.entries(this.seatArt)) {
      if (have.has(file)) out[seat] = CROWD_URL + file;
    }
    return out;
  }

  // ── Live controls ───────────────────────────────────────────────────────────

  getLive(): CrowdLive {
    return {
      ...this.live,
      // Derived rather than stored, so the timestamp stays the single source of
      // truth and the panel never has to know the sentinel.
      mode: Date.now() < this.live.slowUntil ? 'slow' : 'regular',
      pausedForever: this.live.pausedUntil >= HOLD_FOREVER,
      quiescedForever: this.live.quiescedUntil >= HOLD_FOREVER,
      slowForever: this.live.slowUntil >= HOLD_FOREVER,
    };
  }

  /** Sway gently instead of hopping, for a while. */
  slowAndPause(seconds?: number): CrowdLive {
    const secs = this.pauseSeconds(seconds, this.config.slowPauseSeconds);
    this.live.slowUntil = Date.now() + secs * 1000;
    this.logger.info({ seconds: secs }, 'crowd: slow mode');
    return this.getLive();
  }

  /** Sway gently until Resume. */
  slowAndWait(): CrowdLive {
    this.live.slowUntil = HOLD_FOREVER;
    this.logger.info('crowd: slow mode until resume');
    return this.getLive();
  }

  /** Empty the overlay and stop taking updates for a while. */
  clearAndPause(seconds?: number): CrowdLive {
    const secs = this.pauseSeconds(seconds, this.config.clearPauseSeconds);
    const now = Date.now();
    this.live.clearedAt = now;
    this.live.pausedUntil = now + secs * 1000;
    this.logger.info({ seconds: secs }, 'crowd: cleared and paused');
    return this.getLive();
  }

  /** Empty the overlay and leave it that way until Resume. */
  clearAndWait(): CrowdLive {
    this.live.clearedAt = Date.now();
    this.live.pausedUntil = HOLD_FOREVER;
    this.logger.info('crowd: cleared and waiting for resume');
    return this.getLive();
  }

  /** Hold the crowd calm until Resume. */
  quiesceAndWait(): CrowdLive {
    this.live.quiescedUntil = HOLD_FOREVER;
    this.logger.info('crowd: quiesced until resume');
    return this.getLive();
  }

  /** Ramp the crowd down to calm and hold it there for a while. */
  quiesceAndPause(seconds?: number): CrowdLive {
    const secs = this.pauseSeconds(seconds, this.config.quiescePauseSeconds);
    this.live.quiescedUntil = Date.now() + secs * 1000;
    this.logger.info({ seconds: secs }, 'crowd: quiesced');
    return this.getLive();
  }

  /** Cancel any clear, quiesce or slow-mode hold immediately. */
  resume(): CrowdLive {
    this.live.pausedUntil = 0;
    this.live.quiescedUntil = 0;
    this.live.slowUntil = 0;
    return this.getLive();
  }

  setSim(on: boolean): CrowdLive {
    this.live.sim = !!on;
    this.logger.info({ sim: this.live.sim }, 'crowd: simulation toggled');
    return this.getLive();
  }

  private pauseSeconds(requested: number | undefined, fallback: number): number {
    const [lo, hi] = CROWD_RANGES.clearPauseSeconds!;
    const n = Math.round(Number(requested));
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
  }

  // ── Silhouette library ──────────────────────────────────────────────────────

  /**
   * Every silhouette available. Unlike floof photos these are NOT required to be
   * square — a crowd member is taller than they are wide — so the dimensions are
   * reported and the overlay scales by height.
   */
  async listImages(): Promise<CrowdImage[]> {
    try {
      const names = (await readdir(CROWD_DIR)).filter((n) => n.toLowerCase().endsWith('.png'));
      const out: CrowdImage[] = [];
      for (const name of names.sort()) {
        try {
          const buf = await readFile(path.join(CROWD_DIR, name));
          const size = readPngSize(buf);
          out.push({ name, url: CROWD_URL + name, bytes: buf.length, width: size?.width ?? 0, height: size?.height ?? 0 });
        } catch {
          // unreadable file — skip it
        }
      }
      return out;
    } catch {
      return []; // directory missing (bind mount not set up yet)
    }
  }

  async saveImage(rawName: string, buf: Buffer): Promise<CrowdImage> {
    if (buf.length === 0) throw new CrowdError('That file is empty.');
    if (buf.length > MAX_IMAGE_BYTES) throw new CrowdError(`Image is too large (max ${Math.floor(MAX_IMAGE_BYTES / 1024 / 1024)}MB).`);
    const size = readPngSize(buf);
    if (!size) throw new CrowdError('That file is not a PNG.');

    const name = safeCrowdName(rawName);
    await mkdir(CROWD_DIR, { recursive: true });
    await writeFile(path.join(CROWD_DIR, name), buf);
    this.logger.info({ name, bytes: buf.length, size }, 'crowd: silhouette uploaded');
    return { name, url: CROWD_URL + name, bytes: buf.length, width: size.width, height: size.height };
  }

  async deleteImage(rawName: string): Promise<void> {
    const name = safeCrowdName(rawName);
    try {
      await unlink(path.join(CROWD_DIR, name));
    } catch {
      throw new CrowdError(`No silhouette called "${name}".`);
    }
    // Any seat pinned to it goes back to Random, rather than pointing at nothing.
    const left: SeatArt = {};
    let dropped = 0;
    for (const [seat, file] of Object.entries(this.seatArt)) {
      if (file === name) dropped++;
      else left[seat] = file;
    }
    if (dropped) await this.setSeatArt(left);
    this.logger.info({ name, seatsFreed: dropped }, 'crowd: silhouette deleted');
  }
}

/**
 * Reduce an uploaded filename to something safe to write + serve: drop any path,
 * scrub to the charset the asset route allows, and force a single `.png`.
 */
export function safeCrowdName(raw: string): string {
  const base = path.basename(String(raw ?? '')).replace(/[^a-zA-Z0-9._-]/g, '_');
  const stem = base.toLowerCase().endsWith('.png') ? base.slice(0, -4) : base;
  const clean = stem.replace(/^[._-]+/, '') || 'silhouette';
  return `${clean}.png`;
}

/** Keep only well-formed seat keys pointing at plausible filenames. */
function cleanSeatArt(raw: unknown): SeatArt {
  const out: SeatArt = {};
  if (!raw || typeof raw !== 'object') return out;
  let n = 0;
  for (const [seat, file] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^\d{1,3}:\d{1,3}$/.test(seat)) continue;
    const name = String(file ?? '').trim();
    if (!name) continue;                       // blank means Random
    out[seat] = safeCrowdName(name);
    if (++n >= MAX_SEAT_ART) break;
  }
  return out;
}

function clampAnim(v: unknown, fallback: CrowdLevelAnim): CrowdLevelAnim {
  const src = (v ?? {}) as Partial<CrowdLevelAnim>;
  const out = { ...fallback };
  for (const key of Object.keys(CROWD_ANIM_RANGES) as (keyof CrowdLevelAnim)[]) {
    const [lo, hi] = CROWD_ANIM_RANGES[key]!;
    const raw = Number(src[key]);
    const num = FRACTIONAL_ANIM.has(key) ? Math.round(raw * 100) / 100 : Math.round(raw);
    out[key] = Number.isFinite(num) ? Math.min(hi, Math.max(lo, num)) : fallback[key];
  }
  return out;
}

/** Freeze a config and everything nested inside it. */
function deepFreeze(c: CrowdConfig): Readonly<CrowdConfig> {
  Object.freeze(c.thresholds);
  for (const level of c.levels) Object.freeze(level);
  Object.freeze(c.levels);
  Object.freeze(c.calm);
  return Object.freeze(c);
}

function cloneConfig(c: Readonly<CrowdConfig>): CrowdConfig {
  return { ...c, thresholds: [...c.thresholds], levels: c.levels.map((l) => ({ ...l })), calm: { ...c.calm } };
}

function safeJson(s: string): unknown {
  try {
    const o = JSON.parse(s) as unknown;
    return o && typeof o === 'object' ? o : {};
  } catch {
    return {};
  }
}
