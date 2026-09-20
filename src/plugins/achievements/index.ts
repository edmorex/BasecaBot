import type { Plugin } from '../types.js';
import type { ServiceContext } from '../../core/serviceContext.js';

/** WebSocket room the achievement overlay subscribes to. */
const ROOM = 'achievements';
/**
 * Unlocks are buffered briefly so several landing at once become ONE chat line
 * instead of a burst (e.g. a backfilled regular finally chatting).
 */
const FLUSH_MS = 1500;
/** How often a given user's time-based (tenure) achievements are re-checked. */
const DAILY_THROTTLE_MS = 6 * 60 * 60_000;

interface PendingCard {
  key: string;
  emoji: string;
  name: string;
  description: string;
  tier: string;
}

/**
 * Achievements — surfacing layer.
 *
 * The engine (AchievementService) grants unlocks and publishes
 * `achievementUnlocked`; this plugin turns those into a chat announcement and an
 * on-stream overlay card. It also drives the TIME-BASED (tenure) evaluations:
 * rather than sweeping every user nightly — expensive, and it would pop
 * achievements at 4am when nobody is watching — a user's tenure group is
 * re-checked (throttled) when they actually chat, so the celebration lands while
 * they're present.
 *
 * Activity-based groups are evaluated by the code that WRITES the data (the
 * events, first and quotes plugins call ctx.achievements.evaluate), which keeps
 * evaluation strictly ordered after the row it depends on.
 */
export function achievementsPlugin(): Plugin {
  let ctx: ServiceContext;
  let sayText: (channel: string, key: string, vars?: Record<string, string | number>) => Promise<void>;
  const pending = new Map<string, { displayName: string; cards: PendingCard[] }>();
  const lastTenureCheck = new Map<string, number>();
  let flushTimer: ReturnType<typeof setTimeout> | undefined;

  /** Emit buffered unlocks: one chat line per user + one overlay card each. */
  const flush = async () => {
    flushTimer = undefined;
    const batch = [...pending.entries()];
    pending.clear();
    for (const [, { displayName, cards }] of batch) {
      for (const c of cards) {
        ctx.ws.broadcast(ROOM, 'unlocked', {
          user: displayName,
          key: c.key,
          emoji: c.emoji,
          name: c.name,
          description: c.description,
          tier: c.tier,
        });
      }
      const channel = ctx.config.twitch.channel;
      try {
        if (cards.length === 1) {
          const c = cards[0]!;
          await sayText(channel, 'unlocked', { user: displayName, emoji: c.emoji, name: c.name, description: c.description });
        } else {
          const list = cards.map((c) => `${c.emoji} ${c.name}`).join(', ');
          await sayText(channel, 'unlockedMulti', { user: displayName, count: cards.length, list });
        }
      } catch (err) {
        ctx.logger.error({ err }, 'achievements: announce failed');
      }
    }
  };

  return {
    name: 'achievements',
    version: '0.1.0',

    init(context: ServiceContext) {
      ctx = context;

      const strings: Array<{ key: string; label: string; default: string; placeholders: string[] }> = [
        { key: 'unlocked', label: 'Achievement unlocked', default: '🏆 {user} unlocked {emoji} {name} — {description}', placeholders: ['user', 'emoji', 'name', 'description'] },
        { key: 'unlockedMulti', label: 'Several unlocked at once', default: '🏆 {user} unlocked {count} achievements: {list}', placeholders: ['user', 'count', 'list'] },
      ];
      for (const s of strings) ctx.text.register({ feature: 'achievements', ...s });
      sayText = ctx.text.sayer(ctx.chat, 'achievements'); // blank string = silent

      // Time-based achievements, checked when the user is actually around.
      ctx.bus.on('chat', (e) => {
        if (ctx.guests.isGuest(e.channel)) return; // guest chatters aren't tracked users
        const id = e.user.id;
        if (!id) return;
        const now = Date.now();
        if (now - (lastTenureCheck.get(id) ?? 0) < DAILY_THROTTLE_MS) return;
        lastTenureCheck.set(id, now);
        void ctx.achievements.evaluate(id, 'daily').catch((err) => ctx.logger.error({ err }, 'achievements: tenure eval failed'));
      });

      // Surfacing: buffer unlocks, then announce + pop the overlay.
      ctx.bus.on('achievementUnlocked', (e) => {
        const entry = pending.get(e.userId) ?? { displayName: e.displayName, cards: [] };
        entry.displayName = e.displayName;
        entry.cards.push({ key: e.key, emoji: e.emoji, name: e.name, description: e.description, tier: e.tier });
        pending.set(e.userId, entry);
        if (!flushTimer) flushTimer = setTimeout(() => void flush(), FLUSH_MS);
      });
    },

    stop() {
      if (flushTimer) clearTimeout(flushTimer);
      flushTimer = undefined;
      pending.clear();
    },
  };
}
