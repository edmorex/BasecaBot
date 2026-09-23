import { readdir, readFile, writeFile, unlink, mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { Storage } from './storage/index.js';
import type { Logger } from './logger.js';
import { readPngSize } from './floof.js';
import { cleanEmoteNames } from './bossCombat.js';

/** Uploaded boss art AND sound files live here (bind-mounted in production). */
export const BOSS_DIR = path.resolve('public', 'assets', 'boss');
/** Public URL prefix the overlay loads boss media from. */
export const BOSS_URL = '/assets/boss/';
/** Largest boss portrait accepted, in bytes. */
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
/** Largest sound effect accepted. BGM gets a bigger budget (it's a whole track). */
export const MAX_SFX_BYTES = 2 * 1024 * 1024;
export const MAX_BGM_BYTES = 8 * 1024 * 1024;

/** Audio container types we accept and can serve. */
const AUDIO_EXTS: Record<string, string> = { '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav' };

/**
 * The sounds the overlay plays. Each slot is one uploadable file; nothing ships
 * by default, so an empty slot simply plays silence and the game still works.
 */
export const SOUND_SLOTS = [
  { id: 'alert', label: 'Red alert klaxon', hint: 'loops under the WARNING screen', bgm: false },
  { id: 'intel', label: 'Terminal typing', hint: 'plays while the boss dossier types out', bgm: false },
  { id: 'spawn', label: 'Boss arrival', hint: 'one-shot as the boss fades in', bgm: false },
  { id: 'hit', label: 'Hit', hint: 'chat lands damage', bgm: false },
  { id: 'heal', label: 'Heal', hint: 'the boss regains health', bgm: false },
  { id: 'victory', label: 'Victory', hint: 'the boss is defeated', bgm: false },
  { id: 'escape', label: 'Escape', hint: 'the boss gets away', bgm: false },
  { id: 'bgm', label: 'Battle music (BGM)', hint: 'loops for the whole fight', bgm: true },
] as const;

export type SoundSlot = (typeof SOUND_SLOTS)[number]['id'];
const SLOT_IDS = new Set<string>(SOUND_SLOTS.map((s) => s.id));

/** Movement styles a boss can cycle through between taunts. */
export const STYLES = ['pingpong', 'darting', 'spin'] as const;
export type Style = (typeof STYLES)[number];

/** The boss portrait sizes offered in the editor, in design pixels. */
export const SIZES = [128, 256, 384, 512] as const;

/** Game-wide settings (persisted as one JSON blob in the Setting table). */
export interface BossConfig {
  /** Master switch. When off, nothing may start a battle except the admin panel. */
  enabled: boolean;
  /** Seconds a user must wait after landing a hit (or a heal) before they land another. */
  cooldownSeconds: number;
  /** Default delay on the "Start Boss Battle" button, so the streamer can walk away first. */
  startDelaySeconds: number;
  /** Playback volumes, 0–100. */
  volumeSfx: number;
  volumeBgm: number;
  /** How long the red alert screen holds. */
  alertSeconds: number;
  /** How long the incoming-boss dossier holds. */
  intelSeconds: number;
  /** Seconds of movement between taunt pauses (the style is re-rolled at each one). */
  tauntEverySeconds: number;
  /** How long a taunt bubble stays up (the boss is stationary for this). */
  tauntHoldSeconds: number;
  /** Seconds per leg of a "darting" zig-zag. */
  dartSeconds: number;
  /** Radius of the "spin" circular path, in design pixels. */
  spinRadius: number;
  /** Seconds for one full lap of the spin path. */
  spinSeconds: number;
  /** Most chatter avatars drawn along the bottom before they stop being added. */
  crowdMax: number;
  /** How long the death/escape taunt lingers before the final banner lands. */
  outroTauntSeconds: number;
}

export const BOSS_DEFAULTS: BossConfig = {
  enabled: false,
  cooldownSeconds: 30,
  startDelaySeconds: 15,
  volumeSfx: 80,
  volumeBgm: 50,
  alertSeconds: 3,
  intelSeconds: 5,
  tauntEverySeconds: 12,
  tauntHoldSeconds: 3,
  dartSeconds: 0.6,
  spinRadius: 180,
  spinSeconds: 6,
  crowdMax: 60,
  outroTauntSeconds: 3,
};

/** [min, max] bounds for every numeric setting; applied on every write. */
export const BOSS_RANGES: Record<string, readonly [number, number]> = {
  cooldownSeconds: [0, 600],
  startDelaySeconds: [0, 120],
  volumeSfx: [0, 100],
  volumeBgm: [0, 100],
  alertSeconds: [1, 15],
  intelSeconds: [1, 30],
  tauntEverySeconds: [3, 120],
  tauntHoldSeconds: [1, 15],
  dartSeconds: [0.2, 3],
  spinRadius: [40, 600],
  spinSeconds: [2, 30],
  crowdMax: [1, 200],
  outroTauntSeconds: [0, 15],
};

/** Settings that are meaningful as fractions; everything else is rounded. */
const FRACTIONAL = new Set(['dartSeconds']);

/** A boss as the rest of the app sees it — JSON columns already parsed. */
export interface BossView {
  id: number;
  name: string;
  description: string;
  image: string;
  /** Resolved URL for the portrait, or null when no art is set. */
  imageUrl: string | null;
  hp: number;
  emotesPublic: string[];
  emotesPrivate: string[];
  emotesHeal: string[];
  tauntOpening: string;
  tauntBattle: string[];
  tauntDeath: string;
  tauntEscape: string;
  escapeSeconds: number;
  size: number;
  speedFull: number;
  speedNearDeath: number;
  styles: Style[];
  enabled: boolean;
}

/** What the admin panel may send when creating/updating a boss. */
export type BossInput = Partial<Omit<BossView, 'id' | 'imageUrl'>>;

export interface BossImage {
  name: string;
  url: string;
  bytes: number;
}

export interface BossSound {
  slot: string;
  label: string;
  hint: string;
  bgm: boolean;
  /** Uploaded filename, or null when the slot is empty (plays silence). */
  file: string | null;
  url: string | null;
  bytes: number;
}

/** A user-facing problem (bad upload, missing boss); safe to show in chat/UI. */
export class BossError extends Error {}

/** The Twitch CDN image for an emote id, at the largest static size. */
export function emoteImageUrl(emoteId: string): string {
  return `https://static-cdn.jtvnw.net/emoticons/v2/${encodeURIComponent(emoteId)}/default/dark/3.0`;
}

/** How the admin panel's simulate buttons poke a running mock battle. */
export type SimAction = 'hit' | 'miss' | 'heal';

/**
 * Boss Battle — settings, the boss roster, the media libraries and the
 * scoreboard.
 *
 * Bosses get a real table (unlike floof photos, every boss carries its own
 * stats, vulnerabilities and taunts), while game-wide settings ride in a single
 * clamped Setting blob. Portraits and sounds are plain files on disk under
 * `public/assets/boss`, bind-mounted in production so uploads survive a redeploy.
 *
 * The battle state machine itself lives in the boss-battle plugin; this service
 * is the persistence + validation layer, plus the mediators the admin panel uses
 * to drive the plugin (it only ever holds services, never plugins).
 */
export class BossBattleService {
  private config: BossConfig = { ...BOSS_DEFAULTS };
  private starter?: (bossId: number | null, delaySeconds: number) => Promise<string | null>;
  private canceller?: () => Promise<string | null>;
  private simSpawner?: (bossId: number | null) => Promise<string | null>;
  private simActor?: (action: SimAction) => Promise<string | null>;
  /** Emote names already banked, so a repeat sighting costs nothing. */
  private knownEmotes = new Set<string>();

  constructor(
    private readonly storage: Storage,
    private readonly logger: Logger,
  ) {}

  private get db() {
    return this.storage.prisma;
  }

  /** Load persisted settings and make sure the media directory exists. */
  async init(): Promise<void> {
    try {
      const row = await this.db.setting.findUnique({ where: { key: 'boss.config' } });
      if (row) this.config = this.clamp({ ...BOSS_DEFAULTS, ...(safeJson(row.value) as Partial<BossConfig>) });
    } catch (err) {
      this.logger.warn({ err }, 'boss: could not load settings');
    }
    try {
      await mkdir(BOSS_DIR, { recursive: true });
    } catch (err) {
      this.logger.warn({ err, dir: BOSS_DIR }, 'boss: could not create media directory');
    }
    try {
      for (const row of await this.db.emoteArt.findMany({ select: { name: true } })) this.knownEmotes.add(row.name);
    } catch (err) {
      this.logger.warn({ err }, 'boss: could not load the emote art index');
    }
  }

  // ── Emote art ───────────────────────────────────────────────────────────────

  /**
   * Bank the emote ids carried by a chat message's IRC tags.
   *
   * This is the ONLY way to get art for an emote from another channel: Helix can
   * enumerate global and channel emotes, but cannot look one up by name, so a
   * subscriber emote from somebody else's channel is otherwise unresolvable. Each
   * name costs one write the first time it is ever seen and nothing thereafter.
   */
  async rememberEmotes(list: readonly { id: string; name: string }[]): Promise<void> {
    for (const e of list) {
      const name = String(e?.name ?? '');
      const emoteId = String(e?.id ?? '');
      // Numeric-looking ids only; the tag format is stable and this keeps junk out.
      if (!name || !emoteId || this.knownEmotes.has(name)) continue;
      this.knownEmotes.add(name);
      try {
        await this.db.emoteArt.upsert({
          where: { name },
          create: { name, emoteId },
          update: { emoteId, lastSeenAt: new Date() },
        });
      } catch (err) {
        this.knownEmotes.delete(name); // let a later sighting retry
        this.logger.debug({ err, name }, 'boss: could not bank emote art');
      }
    }
  }

  /** Look up banked art for these emote names. Unknown names are simply absent. */
  async lookupEmoteArt(names: readonly string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (!names.length) return out;
    try {
      const rows = await this.db.emoteArt.findMany({ where: { name: { in: [...names] } } });
      for (const r of rows) out.set(r.name, emoteImageUrl(r.emoteId));
    } catch (err) {
      this.logger.warn({ err }, 'boss: emote art lookup failed');
    }
    return out;
  }

  // ── Settings ────────────────────────────────────────────────────────────────

  getConfig(): BossConfig {
    return { ...this.config };
  }

  get defaults(): BossConfig {
    return { ...BOSS_DEFAULTS };
  }

  async setConfig(partial: Partial<BossConfig>): Promise<BossConfig> {
    this.config = this.clamp({ ...this.config, ...partial });
    await this.db.setting.upsert({
      where: { key: 'boss.config' },
      create: { key: 'boss.config', value: JSON.stringify(this.config) },
      update: { value: JSON.stringify(this.config) },
    });
    return this.getConfig();
  }

  private clamp(c: BossConfig): BossConfig {
    const out = { ...BOSS_DEFAULTS, enabled: !!c.enabled };
    for (const key of Object.keys(BOSS_RANGES) as (keyof BossConfig)[]) {
      const [lo, hi] = BOSS_RANGES[key]!;
      const raw = Number(c[key]);
      const num = FRACTIONAL.has(key) ? Math.round(raw * 100) / 100 : Math.round(raw);
      (out[key] as number) = Number.isFinite(num) ? Math.min(hi, Math.max(lo, num)) : (BOSS_DEFAULTS[key] as number);
    }
    return out;
  }

  // ── Plugin mediators ────────────────────────────────────────────────────────
  // The plugin owns the battle; the admin panel only has services. These hooks
  // are how a button press reaches the state machine.

  setStarter(fn: (bossId: number | null, delaySeconds: number) => Promise<string | null>): void {
    this.starter = fn;
  }

  setCanceller(fn: () => Promise<string | null>): void {
    this.canceller = fn;
  }

  setSimulators(spawn: (bossId: number | null) => Promise<string | null>, act: (action: SimAction) => Promise<string | null>): void {
    this.simSpawner = spawn;
    this.simActor = act;
  }

  /** Queue a real battle. `bossId` null = pick a random enabled boss. */
  async requestStart(bossId: number | null, delaySeconds: number): Promise<string | null> {
    if (!this.starter) return 'The Boss Battle game is not running.';
    const [lo, hi] = BOSS_RANGES.startDelaySeconds!;
    const delay = Math.min(hi, Math.max(lo, Math.round(Number(delaySeconds) || 0)));
    return this.starter(bossId, delay);
  }

  /** Cancel a battle that is counting down but has not started yet. */
  async requestCancel(): Promise<string | null> {
    if (!this.canceller) return 'The Boss Battle game is not running.';
    return this.canceller();
  }

  /**
   * Spawn a MOCK battle. It runs the whole presentation but records nothing —
   * no scoreboard rows, no achievements, no chat — so the overlay can be tuned
   * without polluting the database.
   */
  async requestSimSpawn(bossId: number | null): Promise<string | null> {
    if (!this.simSpawner) return 'The Boss Battle game is not running.';
    return this.simSpawner(bossId);
  }

  /** Stand in for a chatter hitting, missing, or healing during a mock battle. */
  async requestSimAction(action: SimAction): Promise<string | null> {
    if (!this.simActor) return 'The Boss Battle game is not running.';
    return this.simActor(action);
  }

  // ── Boss roster ─────────────────────────────────────────────────────────────

  async listBosses(): Promise<BossView[]> {
    const rows = await this.db.boss.findMany({ orderBy: { name: 'asc' } });
    return rows.map((r) => this.view(r));
  }

  async getBoss(id: number): Promise<BossView | null> {
    const row = await this.db.boss.findUnique({ where: { id } });
    return row ? this.view(row) : null;
  }

  /** One random boss from the enabled pool, or null when the roster is empty. */
  async randomBoss(): Promise<BossView | null> {
    const rows = await this.db.boss.findMany({ where: { enabled: true } });
    if (!rows.length) return null;
    return this.view(rows[Math.floor(Math.random() * rows.length)]!);
  }

  /** Resolve an explicit id, falling back to a random enabled boss when null. */
  async pickBoss(id: number | null): Promise<BossView> {
    const boss = id ? await this.getBoss(id) : await this.randomBoss();
    if (!boss) {
      throw new BossError(
        id ? 'That boss no longer exists.' : 'No enabled bosses have been created yet — make one in the Boss Battle panel first.',
      );
    }
    if (!boss.image) throw new BossError(`"${boss.name}" has no portrait uploaded yet.`);
    return boss;
  }

  async createBoss(input: BossInput): Promise<BossView> {
    const data = this.sanitize(input, true);
    // `sanitize(…, true)` guarantees a name, but the Record type erases that.
    const row = await this.db.boss.create({ data: { ...data, name: String(data.name) } });
    this.logger.info({ id: row.id, name: row.name }, 'boss: created');
    return this.view(row);
  }

  async updateBoss(id: number, input: BossInput): Promise<BossView> {
    const existing = await this.db.boss.findUnique({ where: { id } });
    if (!existing) throw new BossError('That boss no longer exists.');
    const row = await this.db.boss.update({ where: { id }, data: this.sanitize(input, false) });
    return this.view(row);
  }

  async deleteBoss(id: number): Promise<void> {
    try {
      await this.db.boss.delete({ where: { id } });
      this.logger.info({ id }, 'boss: deleted');
    } catch {
      throw new BossError('That boss no longer exists.');
    }
  }

  /**
   * Validate + normalize admin input. `requireName` is set on create so a boss
   * can never be born nameless, while an update may touch a single field.
   */
  private sanitize(input: BossInput, requireName: boolean): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    const has = (k: keyof BossInput) => input[k] !== undefined;

    if (requireName || has('name')) {
      const name = String(input.name ?? '').trim().slice(0, 60);
      if (!name) throw new BossError('Give the boss a name.');
      out.name = name;
    }
    if (has('description')) out.description = String(input.description ?? '').trim().slice(0, 400);
    if (has('image')) {
      // An empty value means "no art" and must stay empty — running it through
      // safeBossFile would invent a filename for a file that does not exist.
      const raw = String(input.image ?? '').trim();
      out.image = raw ? safeBossFile(raw, '.png') : '';
    }
    if (has('hp')) out.hp = clampInt(input.hp, 1, 500, 20);
    if (has('emotesPublic')) out.emotesPublic = JSON.stringify(cleanEmoteNames(input.emotesPublic));
    if (has('emotesPrivate')) out.emotesPrivate = JSON.stringify(cleanEmoteNames(input.emotesPrivate));
    if (has('emotesHeal')) out.emotesHeal = JSON.stringify(cleanEmoteNames(input.emotesHeal));
    if (has('tauntOpening')) out.tauntOpening = String(input.tauntOpening ?? '').trim().slice(0, 200);
    if (has('tauntDeath')) out.tauntDeath = String(input.tauntDeath ?? '').trim().slice(0, 200);
    if (has('tauntEscape')) out.tauntEscape = String(input.tauntEscape ?? '').trim().slice(0, 200);
    if (has('tauntBattle')) out.tauntBattle = JSON.stringify(cleanLines(input.tauntBattle));
    if (has('escapeSeconds')) out.escapeSeconds = clampInt(input.escapeSeconds, 10, 3600, 180);
    if (has('size')) {
      const size = clampInt(input.size, 128, 512, 256);
      // Snap to the offered sizes so the overlay never has to reason about odd art.
      out.size = SIZES.reduce((best, s) => (Math.abs(s - size) < Math.abs(best - size) ? s : best), SIZES[1]);
    }
    if (has('speedFull')) out.speedFull = clampInt(input.speedFull, 1, 10, 9);
    if (has('speedNearDeath')) out.speedNearDeath = clampInt(input.speedNearDeath, 1, 10, 2);
    if (has('styles')) {
      const list = Array.isArray(input.styles) ? input.styles.map(String).filter((s): s is Style => (STYLES as readonly string[]).includes(s)) : [];
      // A boss with no styles ticked would stand perfectly still; fall back.
      out.styles = JSON.stringify(list.length ? [...new Set(list)] : ['pingpong']);
    }
    if (has('enabled')) out.enabled = !!input.enabled;
    return out;
  }

  /** Parse a stored row into the shape everything else uses. */
  private view(r: {
    id: number; name: string; description: string; image: string; hp: number;
    emotesPublic: string; emotesPrivate: string; emotesHeal: string;
    tauntOpening: string; tauntBattle: string; tauntDeath: string; tauntEscape: string;
    escapeSeconds: number; size: number; speedFull: number; speedNearDeath: number;
    styles: string; enabled: boolean;
  }): BossView {
    const styles = jsonArray(r.styles).filter((s): s is Style => (STYLES as readonly string[]).includes(s));
    return {
      id: r.id,
      name: r.name,
      description: r.description,
      image: r.image,
      imageUrl: r.image ? BOSS_URL + r.image : null,
      hp: r.hp,
      emotesPublic: jsonArray(r.emotesPublic),
      emotesPrivate: jsonArray(r.emotesPrivate),
      emotesHeal: jsonArray(r.emotesHeal),
      tauntOpening: r.tauntOpening,
      tauntBattle: jsonArray(r.tauntBattle),
      tauntDeath: r.tauntDeath,
      tauntEscape: r.tauntEscape,
      escapeSeconds: r.escapeSeconds,
      size: r.size,
      speedFull: r.speedFull,
      speedNearDeath: r.speedNearDeath,
      styles: styles.length ? styles : ['pingpong'],
      enabled: r.enabled,
    };
  }

  // ── Portrait library ────────────────────────────────────────────────────────

  async listImages(): Promise<BossImage[]> {
    try {
      const names = (await readdir(BOSS_DIR)).filter((n) => n.toLowerCase().endsWith('.png'));
      const out: BossImage[] = [];
      for (const name of names.sort()) {
        try {
          const buf = await readFile(path.join(BOSS_DIR, name));
          out.push({ name, url: BOSS_URL + name, bytes: buf.length });
        } catch {
          // unreadable file — skip it
        }
      }
      return out;
    } catch {
      return []; // directory missing (bind mount not set up yet)
    }
  }

  /** Store a boss portrait. Same rules as floof art: a real, square PNG. */
  async saveImage(rawName: string, buf: Buffer): Promise<BossImage> {
    if (buf.length === 0) throw new BossError('That file is empty.');
    if (buf.length > MAX_IMAGE_BYTES) throw new BossError(`Image is too large (max ${mb(MAX_IMAGE_BYTES)}).`);
    const size = readPngSize(buf);
    if (!size) throw new BossError('That file is not a PNG.');
    if (size.width !== size.height) throw new BossError(`Boss art must be square (this one is ${size.width}×${size.height}).`);

    const name = safeBossFile(rawName, '.png');
    await mkdir(BOSS_DIR, { recursive: true });
    await writeFile(path.join(BOSS_DIR, name), buf);
    this.logger.info({ name, bytes: buf.length }, 'boss: image uploaded');
    return { name, url: BOSS_URL + name, bytes: buf.length };
  }

  async deleteImage(rawName: string): Promise<void> {
    const name = safeBossFile(rawName, '.png');
    try {
      await unlink(path.join(BOSS_DIR, name));
    } catch {
      throw new BossError(`No image called "${name}".`);
    }
    // Any boss still pointing at it would render a broken portrait, so clear it.
    await this.db.boss.updateMany({ where: { image: name }, data: { image: '' } });
    this.logger.info({ name }, 'boss: image deleted');
  }

  // ── Sound library ───────────────────────────────────────────────────────────

  /** Every sound slot with whatever file is currently loaded into it. */
  async listSounds(): Promise<BossSound[]> {
    let files: string[] = [];
    try {
      files = await readdir(BOSS_DIR);
    } catch {
      files = [];
    }
    const out: BossSound[] = [];
    for (const slot of SOUND_SLOTS) {
      const file = files.find((f) => f.startsWith(`sfx-${slot.id}.`) && AUDIO_EXTS[path.extname(f).toLowerCase()]);
      let bytes = 0;
      if (file) {
        try {
          bytes = (await readFile(path.join(BOSS_DIR, file))).length;
        } catch {
          bytes = 0;
        }
      }
      out.push({
        slot: slot.id,
        label: slot.label,
        hint: slot.hint,
        bgm: slot.bgm,
        file: file ?? null,
        url: file ? BOSS_URL + file : null,
        bytes,
      });
    }
    return out;
  }

  /**
   * Store a sound for one slot. The file is renamed to `sfx-<slot>.<ext>`, and
   * any previous upload for that slot (in any container) is removed first, so a
   * slot can never end up holding two files that both look current.
   */
  async saveSound(slotId: string, rawName: string, buf: Buffer): Promise<BossSound> {
    if (!SLOT_IDS.has(slotId)) throw new BossError('Unknown sound slot.');
    const slot = SOUND_SLOTS.find((s) => s.id === slotId)!;
    const limit = slot.bgm ? MAX_BGM_BYTES : MAX_SFX_BYTES;
    if (buf.length === 0) throw new BossError('That file is empty.');
    if (buf.length > limit) throw new BossError(`Sound is too large (max ${mb(limit)}).`);

    const ext = path.extname(String(rawName ?? '')).toLowerCase();
    if (!AUDIO_EXTS[ext]) throw new BossError('Sounds must be .mp3, .ogg or .wav.');

    await this.clearSound(slotId);
    const name = `sfx-${slotId}${ext}`;
    await mkdir(BOSS_DIR, { recursive: true });
    await writeFile(path.join(BOSS_DIR, name), buf);
    this.logger.info({ slot: slotId, name, bytes: buf.length }, 'boss: sound uploaded');
    return { slot: slotId, label: slot.label, hint: slot.hint, bgm: slot.bgm, file: name, url: BOSS_URL + name, bytes: buf.length };
  }

  /** Empty a slot (the overlay then plays silence for it). */
  async clearSound(slotId: string): Promise<void> {
    if (!SLOT_IDS.has(slotId)) throw new BossError('Unknown sound slot.');
    let files: string[] = [];
    try {
      files = await readdir(BOSS_DIR);
    } catch {
      return;
    }
    for (const f of files) {
      if (f.startsWith(`sfx-${slotId}.`) && AUDIO_EXTS[path.extname(f).toLowerCase()]) {
        await unlink(path.join(BOSS_DIR, f)).catch(() => {});
      }
    }
  }

  // ── Scoreboard ──────────────────────────────────────────────────────────────

  /**
   * Credit a won battle: everyone who landed a hit gets a defeat, and the user
   * who struck the killing blow also gets a kill. Returns how many rows changed.
   */
  async recordDefeat(userIds: string[], killerId: string | null): Promise<number> {
    let n = 0;
    for (const userId of new Set(userIds)) {
      const kill = userId === killerId ? 1 : 0;
      try {
        await this.db.bossStat.upsert({
          where: { userId },
          create: { userId, defeats: 1, kills: kill, lastAt: new Date() },
          update: { defeats: { increment: 1 }, kills: { increment: kill }, lastAt: new Date() },
        });
        n++;
      } catch (err) {
        this.logger.error({ err, userId }, 'boss: could not record defeat');
      }
    }
    return n;
  }

  /** A player's battle record plus their rank among all defeaters. */
  async statsFor(userId: string): Promise<{ defeats: number; kills: number; rank: number | null }> {
    const row = await this.db.bossStat.findUnique({ where: { userId } });
    if (!row || row.defeats === 0) return { defeats: 0, kills: 0, rank: null };
    const ahead = await this.db.bossStat.count({ where: { defeats: { gt: row.defeats } } });
    return { defeats: row.defeats, kills: row.kills, rank: ahead + 1 };
  }

  /** Leaderboard rows, most battles won first. */
  async topDefeats(limit = 10): Promise<{ displayName: string; defeats: number; kills: number }[]> {
    const rows = await this.db.bossStat.findMany({
      where: { defeats: { gt: 0 } },
      orderBy: [{ defeats: 'desc' }, { kills: 'desc' }],
      take: limit,
      include: { user: { select: { displayName: true } } },
    });
    return rows.map((r) => ({ displayName: r.user.displayName, defeats: r.defeats, kills: r.kills }));
  }
}

/**
 * Reduce an uploaded filename to something safe to write + serve: drop any path,
 * scrub to the charset the asset route allows, and force the expected extension.
 * Leading dots are stripped from the STEM so a hostile "..." can't become a bare,
 * extension-less file.
 */
export function safeBossFile(raw: string, ext: string): string {
  const base = path.basename(String(raw ?? '')).replace(/[^a-zA-Z0-9._-]/g, '_');
  const stem = base.toLowerCase().endsWith(ext) ? base.slice(0, -ext.length) : base;
  const clean = stem.replace(/^[._-]+/, '') || 'boss';
  return `${clean}${ext}`;
}

function clampInt(v: unknown, lo: number, hi: number, fallback: number): number {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
}

function mb(bytes: number): string {
  return `${Math.floor(bytes / 1024 / 1024)}MB`;
}

/** Trim, drop blanks/dupes and cap a free-text list (battle taunts). */
function cleanLines(list: unknown, max = 50): string[] {
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  for (const raw of list) {
    const line = String(raw ?? '').trim().slice(0, 200);
    if (line && !out.some((t) => t.toLowerCase() === line.toLowerCase())) out.push(line);
    if (out.length >= max) break;
  }
  return out;
}

function jsonArray(s: string): string[] {
  try {
    const v = JSON.parse(s) as unknown;
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

function safeJson(s: string): unknown {
  try {
    const o = JSON.parse(s) as unknown;
    return o && typeof o === 'object' ? o : {};
  } catch {
    return {};
  }
}
