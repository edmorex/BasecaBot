import type { Storage } from './storage/index.js';
import type { EventBus } from '../core/eventBus.js';
import type { AppConfig } from './config.js';
import type { Logger } from './logger.js';
import {
  ACHIEVEMENTS,
  METRICS,
  TRIGGER_GROUPS,
  defForKey,
  type AchievementDef,
  type Tier,
  type TriggerGroup,
} from './achievementCatalog.js';

/** A newly granted unlock (returned by evaluate/backfill). */
export interface Unlock {
  /** Resolved key actually stored (may carry an occurrence suffix). */
  key: string;
  def: AchievementDef;
  value: number;
}

/** One catalog entry with this user's state, for the profile page. */
export interface AchievementProgress {
  key: string;
  name: string;
  description: string;
  emoji: string;
  tier: Tier;
  group: TriggerGroup;
  current: number;
  target: number;
  unlocked: boolean;
  unlockedAt: string | null;
}

/**
 * Achievements engine.
 *
 * Every 1.0 achievement is a THRESHOLD OVER A LIVE QUERY, so one evaluator
 * serves all three needs: live unlocking, the historical backfill, and the
 * profile page's progress bars. Only unlocks are persisted (UserAchievement);
 * progress is always derived, which keeps granting idempotent and means a
 * re-run can never double-award.
 *
 * Surfacing is decoupled: a new unlock is published as an `achievementUnlocked`
 * BotEvent and the achievements plugin decides how to announce it. Backfilled
 * grants are silent by design.
 */
export class AchievementService {
  constructor(
    private readonly storage: Storage,
    private readonly bus: EventBus,
    private readonly config: AppConfig,
    private readonly logger: Logger,
  ) {}

  private get db() {
    return this.storage.prisma;
  }

  /** The static catalog (definitions live in code). */
  get catalog(): AchievementDef[] {
    return ACHIEVEMENTS;
  }

  /**
   * Evaluate one trigger group for a user and grant anything newly earned.
   * `silent` suppresses the bus event (used by the backfill).
   */
  async evaluate(userId: string, group: TriggerGroup, opts: { silent?: boolean } = {}): Promise<Unlock[]> {
    const defs = ACHIEVEMENTS.filter((d) => d.group === group);
    if (!defs.length) return [];
    const values = await this.measure(defs, userId);
    const already = await this.unlockedKeys(userId);

    const earned: Unlock[] = [];
    for (const def of defs) {
      const value = values.get(def.metric) ?? 0;
      if (value < def.target) continue;
      const key = def.keyFor ? def.keyFor(value) : def.key;
      if (already.has(key)) continue;
      if (await this.grant(userId, key, value)) earned.push({ key, def, value });
    }
    if (earned.length && !opts.silent) await this.publish(userId, earned);
    return earned;
  }

  /** Evaluate every group (used by the backfill and by `!achievements`-style refreshes). */
  async evaluateAll(userId: string, opts: { silent?: boolean } = {}): Promise<Unlock[]> {
    const all: Unlock[] = [];
    for (const group of TRIGGER_GROUPS) all.push(...(await this.evaluate(userId, group, opts)));
    return all;
  }

  /** The whole catalog with this user's progress + unlock state, for the profile page. */
  async listForUser(userId: string): Promise<AchievementProgress[]> {
    const values = await this.measure(ACHIEVEMENTS, userId);
    const rows = await this.db.userAchievement.findMany({ where: { userId }, select: { key: true, unlockedAt: true } });
    // Map BASE key -> most recent unlock, so a repeatable shows its latest occurrence.
    const byBase = new Map<string, Date>();
    for (const r of rows) {
      const base = r.key.includes(':') ? r.key.slice(0, r.key.indexOf(':')) : r.key;
      const prev = byBase.get(base);
      if (!prev || r.unlockedAt > prev) byBase.set(base, r.unlockedAt);
    }
    return ACHIEVEMENTS.map((d) => {
      const at = byBase.get(d.key) ?? null;
      return {
        key: d.key,
        name: d.name,
        description: d.description,
        emoji: d.emoji,
        tier: d.tier,
        group: d.group,
        current: values.get(d.metric) ?? 0,
        target: d.target,
        unlocked: at !== null,
        unlockedAt: at ? at.toISOString() : null,
      };
    });
  }

  /**
   * Grant every achievement a user's HISTORY already satisfies, silently.
   * Run this before enabling announcements, or the first sweep will flood chat
   * with years of retroactive unlocks.
   */
  async backfillAll(onProgress?: (done: number, total: number) => void): Promise<{ users: number; granted: number }> {
    const users = await this.db.user.findMany({ select: { id: true } });
    let granted = 0;
    for (const [i, u] of users.entries()) {
      try {
        granted += (await this.evaluateAll(u.id, { silent: true })).length;
      } catch (err) {
        this.logger.error({ err, userId: u.id }, 'achievements: backfill failed for user');
      }
      onProgress?.(i + 1, users.length);
    }
    this.logger.info({ users: users.length, granted }, 'achievements: backfill complete');
    return { users: users.length, granted };
  }

  /**
   * How many DISTINCT users hold each achievement, keyed by base key (occurrence
   * suffixes on repeatables fold into their base). Drives the admin catalog view.
   */
  async holderCounts(): Promise<Record<string, number>> {
    const rows = await this.db.userAchievement.findMany({ select: { userId: true, key: true } });
    const byBase = new Map<string, Set<string>>();
    for (const r of rows) {
      const base = r.key.includes(':') ? r.key.slice(0, r.key.indexOf(':')) : r.key;
      const set = byBase.get(base) ?? new Set<string>();
      set.add(r.userId);
      byBase.set(base, set);
    }
    const out: Record<string, number> = {};
    for (const [base, users] of byBase) out[base] = users.size;
    return out;
  }

  /** Compute each DISTINCT metric used by `defs` exactly once. */
  private async measure(defs: AchievementDef[], userId: string): Promise<Map<string, number>> {
    const now = new Date();
    const names = [...new Set(defs.map((d) => d.metric))];
    const out = new Map<string, number>();
    await Promise.all(
      names.map(async (name) => {
        const fn = METRICS[name];
        if (!fn) return;
        try {
          out.set(name, await fn(this.db, userId, now));
        } catch (err) {
          this.logger.error({ err, metric: name, userId }, 'achievements: metric failed');
          out.set(name, 0); // a broken metric must not block other achievements
        }
      }),
    );
    return out;
  }

  private async unlockedKeys(userId: string): Promise<Set<string>> {
    const rows = await this.db.userAchievement.findMany({ where: { userId }, select: { key: true } });
    return new Set(rows.map((r) => r.key));
  }

  /** Insert an unlock. Returns false if the user already had it (unique index). */
  private async grant(userId: string, key: string, value: number): Promise<boolean> {
    try {
      await this.db.userAchievement.create({ data: { userId, key, value } });
      return true;
    } catch {
      return false; // already unlocked (or the user row vanished) — never double-award
    }
  }

  /** Announce new unlocks on the bus for the plugin to surface. */
  private async publish(userId: string, earned: Unlock[]): Promise<void> {
    const user = await this.db.user.findUnique({ where: { id: userId }, select: { displayName: true } });
    for (const u of earned) {
      await this.bus.publish({
        type: 'achievementUnlocked',
        channel: this.config.twitch.channel,
        ts: Date.now(),
        userId,
        displayName: user?.displayName ?? userId,
        key: u.key,
        name: u.def.name,
        description: u.def.description,
        emoji: u.def.emoji,
        tier: u.def.tier,
        value: u.value,
      });
    }
  }
}

export { defForKey };
