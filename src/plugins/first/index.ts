import type { Plugin } from '../types.js';
import type { ServiceContext } from '../../core/serviceContext.js';
import type { CommandEvent } from '../../core/events.js';
import { PermissionLevel } from '../../core/events.js';
import type { CheckInResult, LeaderRow } from '../../services/first.js';

/** English pluralization: pick singular/plural by count. */
const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);

/**
 * The "!first" race. When the stream is live, users race to be the first to
 * type `!first`; the earlier the check-in the more ranking points (1st = 10 …
 * 10th = 1). Cumulative stats + leaderboards persist across streams.
 *
 * A race is scoped to the current stream's start time, so it resets automatically
 * each broadcast. All the scoring lives in FirstService.
 */
export function firstPlugin(): Plugin {
  return {
    name: 'first',
    version: '0.1.0',

    init(ctx: ServiceContext) {
      const say = (ch: string, msg: string) => ctx.chat.say(ch, msg);

      // Per-user cooldown on check-in ATTEMPTS (the bare "!first"), so nobody can
      // spam it to jump the gun before the stream is live. The router doesn't
      // cooldown a group's onUnknown path, and gating the whole group would also
      // throttle "!first top"/"stats", so we rate-limit here.
      const CHECKIN_COOLDOWN_MS = 60_000;
      const lastAttempt = new Map<string, number>();

      // ── Live-stream lookup (cached briefly; a stream's start time is its race id) ──
      let broadcasterId: string | undefined;
      let streamCache: { at: number; value: { startDate: Date } | null } | undefined;
      const STREAM_TTL_MS = 10_000;

      const getBroadcasterId = async (): Promise<string | undefined> => {
        if (broadcasterId) return broadcasterId;
        const u = await ctx.api.users.getUserByName(ctx.config.twitch.broadcasterUsername);
        broadcasterId = u?.id;
        return broadcasterId;
      };

      const currentStream = async (): Promise<{ startDate: Date } | null> => {
        if (streamCache && Date.now() - streamCache.at < STREAM_TTL_MS) return streamCache.value;
        let value: { startDate: Date } | null = streamCache?.value ?? null;
        try {
          const bid = await getBroadcasterId();
          const s = bid ? await ctx.api.streams.getStreamByUserId(bid) : null;
          value = s ? { startDate: s.startDate } : null;
        } catch (err) {
          ctx.logger.warn({ err }, 'first: live check failed; using last-known state');
        }
        streamCache = { at: Date.now(), value };
        return value;
      };

      // ── Check-in message per the spec ─────────────────────────────────────────
      const checkinMessage = (name: string, r: CheckInResult): string => {
        if (r.repeat) {
          return `Did you forget you already have claimed to be first? Don’t worry, you are not the first to make this mistake.`;
        }
        const secs = `${r.timeSeconds} ${plural(r.timeSeconds, 'second', 'seconds')}`;
        if (r.place === 1) {
          return `Congratulations ${name}! You are FIRST! You clocked in at ${secs}.`;
        }
        const n = r.place - 1;
        const before = `if you ignore the ${n} ${plural(n, 'person', 'people')} who ${plural(n, 'was', 'were')} FIRST before you`;
        return r.place <= 10
          ? `Congratulations ${name}! You are FIRST… ${before}. You clocked in at ${secs}.`
          : `Congratulations ${name}! You are FIRST… ${before}. Let’s just keep this between us.`;
      };

      // ── Leaderboard rendering ─────────────────────────────────────────────────
      const LEADERBOARDS: Record<string, { title: string; fetch: () => Promise<LeaderRow[]>; fmt: (v: number) => string }> = {
        firsts: { title: 'Most FIRSTs', fetch: () => ctx.first.topFirsts(), fmt: (v) => String(v) },
        points: { title: 'Most ranking points', fetch: () => ctx.first.topPoints(), fmt: (v) => String(v) },
        time: { title: 'Fastest average check-in', fetch: () => ctx.first.topTime(), fmt: (v) => `${v.toFixed(1)}s` },
      };

      ctx.commands.registerGroup('first', {
        description:
          'Race to be FIRST when the stream goes live! "!first" checks you in. "!first top [firsts|points|time]" shows a leaderboard; "!first stats [user]" shows a player\'s stats.',
        permission: PermissionLevel.Viewer,

        // Bare "!first" (and any non-subcommand form) is a check-in.
        onUnknown: async (e: CommandEvent) => {
          const now = Date.now();
          if (now - (lastAttempt.get(e.user.id) ?? 0) < CHECKIN_COOLDOWN_MS) return; // silent cooldown
          lastAttempt.set(e.user.id, now);

          const stream = await currentStream();
          if (!stream) {
            await say(e.channel, `Very naughty! You are not the first person to try and claim first before the stream has started.`);
            return;
          }
          await ctx.users.touch(e.user);
          const streamKey = stream.startDate.toISOString();
          const seconds = Math.max(0, Math.floor((Date.now() - stream.startDate.getTime()) / 1000));
          const result = await ctx.first.checkIn(e.user.id, streamKey, seconds);
          await say(e.channel, checkinMessage(e.user.displayName, result));
        },

        subcommands: {
          top: {
            description: 'Show a !first leaderboard: top firsts (default), points, or time.',
            usage: '[firsts|points|time]',
            aliases: ['leaderboard'],
            globalCooldownSeconds: 3,
            handler: async (e) => {
              const key = (e.args[0] ?? 'firsts').toLowerCase();
              const board = LEADERBOARDS[key];
              if (!board) {
                await say(e.channel, 'Unknown leaderboard. Use: firsts, points, or time.');
                return;
              }
              const rows = await board.fetch();
              if (!rows.length) {
                await say(e.channel, 'No !first results yet — be the FIRST!');
                return;
              }
              const list = rows.map((r, i) => `${i + 1}. ${r.displayName} (${board.fmt(r.value)})`).join(', ');
              await say(e.channel, `🏆 ${board.title}: ${list}`);
            },
          },

          stats: {
            description: "Show a player's !first stats + ranks (defaults to you).",
            usage: '[username]',
            aliases: ['rank'],
            globalCooldownSeconds: 3,
            handler: async (e) => {
              const arg = e.argString.trim();
              let userId = e.user.id;
              let name = e.user.displayName;
              if (arg) {
                const ref = await ctx.users.resolveUserRef(arg);
                if (ref.kind !== 'user') {
                  await say(e.channel, `I don’t know a user called ${arg}.`);
                  return;
                }
                userId = ref.id;
                name = ref.displayName;
              } else {
                await ctx.users.touch(e.user); // ensure the sender is persisted for the lookup
              }

              const s = await ctx.first.statsFor(userId);
              if (!s) {
                await say(e.channel, `${name} hasn’t cracked the top 10 yet.`);
                return;
              }
              const rank = (r: number | null) => (r === null ? '—' : `#${r}`);
              const avgT = s.avgTime === null ? '—' : `${s.avgTime.toFixed(1)}s`;
              const avgP = s.avgPlace === null ? '—' : s.avgPlace.toFixed(1);
              await say(
                e.channel,
                `📊 ${s.displayName}’s FIRST stats — ` +
                  `1sts: ${s.firsts} (${rank(s.ranks.firsts)}) · ` +
                  `top-10s: ${s.topTens} (${rank(s.ranks.topTens)}) · ` +
                  `avg time: ${avgT} (${rank(s.ranks.avgTime)}) · ` +
                  `avg place: ${avgP} (${rank(s.ranks.avgPlace)}) · ` +
                  `points: ${s.points} (${rank(s.ranks.points)})`,
              );
            },
          },
        },
      });
    },
  };
}
