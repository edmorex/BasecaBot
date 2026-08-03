import type { Plugin } from '../types.js';
import type { ServiceContext } from '../../core/serviceContext.js';
import type { CommandEvent, EventUser } from '../../core/events.js';
import { PermissionLevel } from '../../core/events.js';
import type { LeaderRow } from '../../services/first.js';

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
  let startMonitor: () => Promise<void> = async () => {};
  let stopMonitor: () => void = () => {};

  return {
    name: 'first',
    version: '0.1.0',

    init(ctx: ServiceContext) {
      // Editable chat strings (Admin → Text Strings, feature "First"). A blank
      // string is silent, so clearing one on the dashboard disables that message.
      const strings: Array<{ key: string; label: string; default: string; placeholders: string[] }> = [
        { key: 'firstPlace', label: 'Check-in — 1st place', default: 'Congratulations {name}! You are FIRST! You clocked in at {time}.', placeholders: ['name', 'time'] },
        { key: 'topTen', label: 'Check-in — 2nd–10th', default: 'Congratulations {name}! You are FIRST… {others}. You clocked in at {time}.', placeholders: ['name', 'others', 'time'] },
        { key: 'eleventhPlus', label: 'Check-in — 11th+', default: 'Congratulations {name}! You are FIRST… {others}. Let’s just keep this between us.', placeholders: ['name', 'others'] },
        { key: 'repeat', label: 'Check-in — already claimed', default: 'Did you forget you already have claimed to be first? Don’t worry, you are not the first to make this mistake.', placeholders: [] },
        { key: 'notLive', label: 'Check-in — before stream is live', default: 'Very naughty! You are not the first person to try and claim first before the stream has started.', placeholders: [] },
        { key: 'unknownBoard', label: 'Leaderboard — unknown option', default: 'Unknown leaderboard. Use: firsts, points, or time.', placeholders: [] },
        { key: 'noResults', label: 'Leaderboard — no results', default: 'No !first results yet — be the FIRST!', placeholders: [] },
        { key: 'leaderboard', label: 'Leaderboard — line', default: '🏆 {title}: {list}', placeholders: ['title', 'list'] },
        { key: 'unknownUser', label: 'Stats — unknown user', default: 'I don’t know a user called {user}.', placeholders: ['user'] },
        { key: 'noStats', label: 'Stats — no placements', default: '{name} hasn’t cracked the top 10 yet.', placeholders: ['name'] },
        { key: 'stats', label: 'Stats — line', default: '📊 {name}’s FIRST stats — {body}', placeholders: ['name', 'body'] },
      ];
      for (const s of strings) ctx.text.register({ feature: 'first', ...s });
      const sayText = (channel: string, key: string, vars: Record<string, string | number> = {}): Promise<void> => {
        const msg = ctx.text.format('first', key, vars);
        return msg.trim() ? ctx.chat.say(channel, msg) : Promise.resolve();
      };

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

      // ── Live monitor: keep the overlay's active race in sync with the stream,
      // and CLEAR the overlay when the stream goes offline (instead of leaving
      // stale results up until the next race). Runs while the plugin is started.
      let lastKey: string | null | undefined; // undefined = not polled yet
      let monitorHandle: ReturnType<typeof setInterval> | undefined;
      // Hourly is plenty: the board only needs to clear sometime before the next
      // stream, which is always hours away. A check-in sets the active race
      // immediately, so the slow poll only handles the eventual offline clear.
      const POLL_MS = 60 * 60_000;
      const syncRace = async () => {
        const stream = await currentStream();
        const key = stream ? stream.startDate.toISOString() : null;
        if (key === lastKey) return;
        const prev = lastKey;
        lastKey = key;
        ctx.first.setActiveStream(key);
        // A KNOWN race ended (went offline, or a new stream replaced it): clear
        // connected overlays. (Going from offline→live needs no clear — it's
        // already empty — and a new stream's first check-in resets the client.)
        if (prev !== undefined && prev !== null && prev !== key) {
          ctx.ws.broadcast('first', 'clear', {});
        }
      };
      startMonitor = async () => {
        await syncRace();
        monitorHandle = setInterval(() => void syncRace(), POLL_MS);
      };
      stopMonitor = () => {
        if (monitorHandle) clearInterval(monitorHandle);
        monitorHandle = undefined;
      };

      // ── Leaderboard rendering ─────────────────────────────────────────────────
      const LEADERBOARDS: Record<string, { title: string; fetch: () => Promise<LeaderRow[]>; fmt: (v: number) => string }> = {
        firsts: { title: 'Most FIRSTs', fetch: () => ctx.first.topFirsts(), fmt: (v) => String(v) },
        points: { title: 'Most ranking points', fetch: () => ctx.first.topPoints(), fmt: (v) => String(v) },
        time: { title: 'Fastest average check-in', fetch: () => ctx.first.topTime(), fmt: (v) => `${v.toFixed(1)}s` },
      };

      // Fetch the checker-in's Twitch avatar (so the overlay podium can show it),
      // persist it for later snapshots, then broadcast the standing to the "first"
      // overlay room. Best-effort: a missing avatar just broadcasts null.
      const broadcastCheckin = async (streamKey: string, place: number, timeSeconds: number, u: EventUser) => {
        let avatarUrl: string | null = null;
        try {
          const hu = await ctx.api.users.getUserById(u.id);
          avatarUrl = hu?.profilePictureUrl ?? null;
          if (avatarUrl) await ctx.users.touch({ id: u.id, login: u.login, displayName: u.displayName, avatarUrl });
        } catch (err) {
          ctx.logger.debug({ err, user: u.login }, 'first: overlay avatar fetch failed');
        }
        ctx.ws.broadcast('first', 'checkin', { streamKey, place, name: u.displayName, avatarUrl, timeSeconds });
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
            await sayText(e.channel, 'notLive');
            return;
          }
          await ctx.users.touch(e.user);
          const streamKey = stream.startDate.toISOString();
          ctx.first.setActiveStream(streamKey); // ensure the overlay tracks this race
          lastKey = streamKey; // keep the monitor from re-clearing on its next poll
          const seconds = Math.max(0, Math.floor((Date.now() - stream.startDate.getTime()) / 1000));
          const result = await ctx.first.checkIn(e.user.id, streamKey, seconds);
          if (result.repeat) {
            await sayText(e.channel, 'repeat');
          } else {
            const time = `${result.timeSeconds} ${plural(result.timeSeconds, 'second', 'seconds')}`;
            if (result.place === 1) {
              await sayText(e.channel, 'firstPlace', { name: e.user.displayName, time });
            } else {
              const n = result.place - 1;
              const others = `if you ignore the ${n} ${plural(n, 'person', 'people')} who ${plural(n, 'was', 'were')} FIRST before you`;
              await sayText(e.channel, result.place <= 10 ? 'topTen' : 'eleventhPlus', { name: e.user.displayName, others, time });
            }
          }

          // Push the top-10 standings to the OBS overlay. Done after the chat
          // reply and off the hot path (an avatar fetch shouldn't slow the race).
          if (!result.repeat && result.place <= 10) {
            void broadcastCheckin(streamKey, result.place, result.timeSeconds, e.user);
          }
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
                await sayText(e.channel, 'unknownBoard');
                return;
              }
              const rows = await board.fetch();
              if (!rows.length) {
                await sayText(e.channel, 'noResults');
                return;
              }
              const list = rows.map((r, i) => `${i + 1}. ${r.displayName} (${board.fmt(r.value)})`).join(', ');
              await sayText(e.channel, 'leaderboard', { title: board.title, list });
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
                  await sayText(e.channel, 'unknownUser', { user: arg });
                  return;
                }
                userId = ref.id;
                name = ref.displayName;
              } else {
                await ctx.users.touch(e.user); // ensure the sender is persisted for the lookup
              }

              const s = await ctx.first.statsFor(userId);
              if (!s) {
                await sayText(e.channel, 'noStats', { name });
                return;
              }
              const rank = (r: number | null) => (r === null ? '—' : `#${r}`);
              const avgT = s.avgTime === null ? '—' : `${s.avgTime.toFixed(1)}s`;
              const avgP = s.avgPlace === null ? '—' : s.avgPlace.toFixed(1);
              const body =
                `1sts: ${s.firsts} (${rank(s.ranks.firsts)}) · ` +
                `top-10s: ${s.topTens} (${rank(s.ranks.topTens)}) · ` +
                `avg time: ${avgT} (${rank(s.ranks.avgTime)}) · ` +
                `avg place: ${avgP} (${rank(s.ranks.avgPlace)}) · ` +
                `points: ${s.points} (${rank(s.ranks.points)})`;
              await sayText(e.channel, 'stats', { name: s.displayName, body });
            },
          },
        },
      });
    },

    // Begin polling live state once all plugins are initialized.
    async start() {
      await startMonitor();
    },

    // Stop the live poll on shutdown.
    stop() {
      stopMonitor();
    },
  };
}
