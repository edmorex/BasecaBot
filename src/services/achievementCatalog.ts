import type { Storage } from './storage/index.js';

type Db = Storage['prisma'];

/** Which activity re-evaluates a group of achievements. */
export type TriggerGroup = 'first' | 'quote' | 'sub' | 'bits' | 'daily' | 'floof';
export const TRIGGER_GROUPS: TriggerGroup[] = ['first', 'quote', 'sub', 'bits', 'daily', 'floof'];

export type Tier = 'bronze' | 'silver' | 'gold';

/** Check-in time (seconds) that counts as a Speed Demon. */
const SPEED_DEMON_SECONDS = 10;

/**
 * A measurable quantity achievements threshold against. Metrics are declared
 * separately from the definitions so a group's shared metric (e.g. "firsts", used
 * by four achievements) is queried ONCE per evaluation.
 */
export type MetricFn = (db: Db, userId: string, now: Date) => Promise<number>;

/** Whole months elapsed since `from` (calendar-aware, never negative). */
export function monthsSince(from: Date | null | undefined, now: Date): number {
  if (!from) return 0;
  let m = (now.getFullYear() - from.getFullYear()) * 12 + (now.getMonth() - from.getMonth());
  if (now.getDate() < from.getDate()) m--;
  return Math.max(0, m);
}

export const METRICS: Record<string, MetricFn> = {
  // ── !first game (FirstStat / FirstCheckin) ────────────────────────────────
  'first.firsts': async (db, userId) =>
    (await db.firstStat.findUnique({ where: { userId }, select: { firsts: true } }))?.firsts ?? 0,
  'first.topTens': async (db, userId) =>
    (await db.firstStat.findUnique({ where: { userId }, select: { topTens: true } }))?.topTens ?? 0,
  // Boolean metric (0/1): fastest-ever check-in under the threshold.
  'first.speedDemon': async (db, userId) => {
    const r = await db.firstCheckin.aggregate({ where: { userId }, _min: { timeSeconds: true } });
    const best = r._min.timeSeconds;
    return best != null && best < SPEED_DEMON_SECONDS ? 1 : 0;
  },

  // ── Quotes ────────────────────────────────────────────────────────────────
  'quote.quoted': async (db, userId) => db.quote.count({ where: { quotedUserId: userId } }),
  'quote.scribe': async (db, userId) => db.quote.count({ where: { createdById: userId } }),

  // ── Subscriptions (EventLog) ──────────────────────────────────────────────
  'sub.subs': async (db, userId) => db.eventLog.count({ where: { userId, type: 'sub' } }),
  // Twitch sends CUMULATIVE months on each resub, so the max is the true tenure.
  'sub.maxResubMonths': async (db, userId) =>
    (await db.eventLog.aggregate({ where: { userId, type: 'resub' }, _max: { amount: true } }))._max.amount ?? 0,
  'sub.gifted': async (db, userId) =>
    (await db.eventLog.aggregate({ where: { userId, type: 'subgift' }, _sum: { amount: true } }))._sum.amount ?? 0,

  // ── Bits (EventLog) ───────────────────────────────────────────────────────
  'bits.cheers': async (db, userId) => db.eventLog.count({ where: { userId, type: 'bits' } }),
  'bits.total': async (db, userId) =>
    (await db.eventLog.aggregate({ where: { userId, type: 'bits' }, _sum: { amount: true } }))._sum.amount ?? 0,

  // ── Pet the Floof ─────────────────────────────────────────────────────────
  'floof.wins': async (db, userId) =>
    (await db.floofStat.findUnique({ where: { userId }, select: { wins: true } }))?.wins ?? 0,

  // ── Tenure / identity ─────────────────────────────────────────────────────
  'tenure.months': async (db, userId, now) =>
    monthsSince((await db.user.findUnique({ where: { id: userId }, select: { firstSeenAt: true } }))?.firstSeenAt, now),
  'tenure.years': async (db, userId, now) =>
    Math.floor(
      monthsSince((await db.user.findUnique({ where: { id: userId }, select: { firstSeenAt: true } }))?.firstSeenAt, now) / 12,
    ),
  'tenure.aliases': async (db, userId) => db.userName.count({ where: { userId, kind: 'alias' } }),
};

/** One achievement in the catalog. Unlocked when its metric reaches `target`. */
export interface AchievementDef {
  /** Stable catalog key. */
  key: string;
  name: string;
  description: string;
  /** Badge art for 1.0 is an emoji (no asset pipeline). */
  emoji: string;
  tier: Tier;
  group: TriggerGroup;
  metric: keyof typeof METRICS & string;
  target: number;
  /**
   * REPEATABLE achievements only: derive a per-occurrence key from the metric
   * value, so each occurrence is its own unlock row (and its own on-stream pop).
   */
  keyFor?: (value: number) => string;
}

/**
 * The 1.0 catalog. Every entry is backed by data the bot ALREADY persists, so all
 * of them can be backfilled from history. (Achievements needing new tracking —
 * message counts, watch time, emotes — are deliberately out of scope for 1.0.)
 */
export const ACHIEVEMENTS: AchievementDef[] = [
  // ── !first ────────────────────────────────────────────────────────────────
  { key: 'first.blood', name: 'First Blood', description: 'Win !first for the very first time.', emoji: '🩸', tier: 'bronze', group: 'first', metric: 'first.firsts', target: 1 },
  { key: 'first.champion1', name: 'Champion I', description: 'Win !first 10 times.', emoji: '🏆', tier: 'bronze', group: 'first', metric: 'first.firsts', target: 10 },
  { key: 'first.champion2', name: 'Champion II', description: 'Win !first 50 times.', emoji: '🏆', tier: 'silver', group: 'first', metric: 'first.firsts', target: 50 },
  { key: 'first.champion3', name: 'Champion III', description: 'Win !first 100 times.', emoji: '👑', tier: 'gold', group: 'first', metric: 'first.firsts', target: 100 },
  { key: 'first.podium1', name: 'Podium Regular I', description: 'Finish in the top 10 of !first 10 times.', emoji: '🥉', tier: 'bronze', group: 'first', metric: 'first.topTens', target: 10 },
  { key: 'first.podium2', name: 'Podium Regular II', description: 'Finish in the top 10 of !first 50 times.', emoji: '🥈', tier: 'silver', group: 'first', metric: 'first.topTens', target: 50 },
  { key: 'first.podium3', name: 'Podium Regular III', description: 'Finish in the top 10 of !first 100 times.', emoji: '🥇', tier: 'gold', group: 'first', metric: 'first.topTens', target: 100 },
  { key: 'first.speed', name: 'Speed Demon', description: `Check in to !first in under ${SPEED_DEMON_SECONDS} seconds.`, emoji: '⚡', tier: 'silver', group: 'first', metric: 'first.speedDemon', target: 1 },

  // ── Quotes ────────────────────────────────────────────────────────────────
  { key: 'quote.quoted1', name: 'Quotable I', description: 'Be quoted for the first time.', emoji: '💬', tier: 'bronze', group: 'quote', metric: 'quote.quoted', target: 1 },
  { key: 'quote.quoted2', name: 'Quotable II', description: 'Be quoted 10 times.', emoji: '💬', tier: 'silver', group: 'quote', metric: 'quote.quoted', target: 10 },
  { key: 'quote.quoted3', name: 'Quotable III', description: 'Be quoted 50 times.', emoji: '📜', tier: 'gold', group: 'quote', metric: 'quote.quoted', target: 50 },
  { key: 'quote.scribe1', name: 'Scribe I', description: 'Add your first quote.', emoji: '✍️', tier: 'bronze', group: 'quote', metric: 'quote.scribe', target: 1 },
  { key: 'quote.scribe2', name: 'Scribe II', description: 'Add 10 quotes.', emoji: '✍️', tier: 'silver', group: 'quote', metric: 'quote.scribe', target: 10 },
  { key: 'quote.scribe3', name: 'Scribe III', description: 'Add 50 quotes.', emoji: '📚', tier: 'gold', group: 'quote', metric: 'quote.scribe', target: 50 },

  // ── Subscriptions ─────────────────────────────────────────────────────────
  { key: 'sub.welcome', name: 'Welcome to the Club', description: 'Subscribe to the channel.', emoji: '🎉', tier: 'bronze', group: 'sub', metric: 'sub.subs', target: 1 },
  { key: 'sub.loyal1', name: 'Loyal I', description: 'Stay subscribed for 3 months.', emoji: '💜', tier: 'bronze', group: 'sub', metric: 'sub.maxResubMonths', target: 3 },
  { key: 'sub.loyal2', name: 'Loyal II', description: 'Stay subscribed for 6 months.', emoji: '💜', tier: 'silver', group: 'sub', metric: 'sub.maxResubMonths', target: 6 },
  { key: 'sub.loyal3', name: 'Loyal III', description: 'Stay subscribed for 12 months.', emoji: '💎', tier: 'gold', group: 'sub', metric: 'sub.maxResubMonths', target: 12 },
  { key: 'sub.loyal4', name: 'Loyal IV', description: 'Stay subscribed for 24 months.', emoji: '👑', tier: 'gold', group: 'sub', metric: 'sub.maxResubMonths', target: 24 },
  { key: 'sub.santa1', name: 'Santa I', description: 'Gift a subscription.', emoji: '🎁', tier: 'bronze', group: 'sub', metric: 'sub.gifted', target: 1 },
  { key: 'sub.santa2', name: 'Santa II', description: 'Gift 5 subscriptions.', emoji: '🎁', tier: 'silver', group: 'sub', metric: 'sub.gifted', target: 5 },
  { key: 'sub.santa3', name: 'Santa III', description: 'Gift 25 subscriptions.', emoji: '🎅', tier: 'gold', group: 'sub', metric: 'sub.gifted', target: 25 },

  // ── Bits ──────────────────────────────────────────────────────────────────
  { key: 'bits.first', name: 'First Cheer', description: 'Cheer bits for the first time.', emoji: '✨', tier: 'bronze', group: 'bits', metric: 'bits.cheers', target: 1 },
  { key: 'bits.sparkler', name: 'Sparkler', description: 'Cheer 100 bits in total.', emoji: '🎆', tier: 'bronze', group: 'bits', metric: 'bits.total', target: 100 },
  { key: 'bits.fireworks', name: 'Fireworks', description: 'Cheer 1,000 bits in total.', emoji: '🎇', tier: 'silver', group: 'bits', metric: 'bits.total', target: 1000 },
  { key: 'bits.supernova', name: 'Supernova', description: 'Cheer 10,000 bits in total.', emoji: '🌟', tier: 'gold', group: 'bits', metric: 'bits.total', target: 10000 },

  // ── Pet the Floof ─────────────────────────────────────────────────────────
  { key: 'floof.friend1', name: 'Floof Friend I', description: 'Be the first to !pet a floof.', emoji: '🐾', tier: 'bronze', group: 'floof', metric: 'floof.wins', target: 1 },
  { key: 'floof.friend2', name: 'Floof Friend II', description: 'Win Pet the Floof 10 times.', emoji: '🐱', tier: 'silver', group: 'floof', metric: 'floof.wins', target: 10 },
  { key: 'floof.friend3', name: 'Floof Friend III', description: 'Win Pet the Floof 50 times.', emoji: '💖', tier: 'gold', group: 'floof', metric: 'floof.wins', target: 50 },

  // ── Tenure / identity ─────────────────────────────────────────────────────
  { key: 'tenure.foster1', name: 'Foster Fam I', description: 'Known to the bot for 6 months.', emoji: '🏡', tier: 'bronze', group: 'daily', metric: 'tenure.months', target: 6 },
  { key: 'tenure.foster2', name: 'Foster Fam II', description: 'Known to the bot for 1 year.', emoji: '🏡', tier: 'silver', group: 'daily', metric: 'tenure.months', target: 12 },
  { key: 'tenure.foster3', name: 'Foster Fam III', description: 'Known to the bot for 2 years.', emoji: '🏰', tier: 'gold', group: 'daily', metric: 'tenure.months', target: 24 },
  // Repeatable: one unlock per completed year (key carries the occurrence).
  { key: 'tenure.anniversary', name: 'Anniversary', description: 'Celebrate another year since the bot first saw you.', emoji: '🎂', tier: 'silver', group: 'daily', metric: 'tenure.years', target: 1, keyFor: (v) => `tenure.anniversary:${v}` },
  { key: 'tenure.names', name: 'Person of Many Names', description: 'Set an alias for yourself.', emoji: '🎭', tier: 'bronze', group: 'daily', metric: 'tenure.aliases', target: 1 },
];

/** Look up a definition by its BASE key (occurrence suffixes are stripped). */
export function defForKey(key: string): AchievementDef | undefined {
  const base = key.includes(':') ? key.slice(0, key.indexOf(':')) : key;
  return ACHIEVEMENTS.find((a) => a.key === base);
}
