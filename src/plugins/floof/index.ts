import type { Plugin } from '../types.js';
import type { ServiceContext } from '../../core/serviceContext.js';
import type { CommandEvent } from '../../core/events.js';
import { PermissionLevel } from '../../core/events.js';
import { FLOOF_VARIABLES, type FloofConfig } from '../../services/floof.js';
import { ChatError } from '../../core/chatError.js';

/** WebSocket room the floof overlay subscribes to. */
const ROOM = 'floof';
/** Per-user cooldown on a `!pet` that finds no floof, so it can't be spammed. */
const IDLE_COOLDOWN_MS = 30_000;
/** How often the scheduler re-checks when it's waiting (also re-checks live state). */
const TICK_MS = 15_000;

/** The currently-visible floof, if any. */
interface Round {
  image: string;
  startedAt: number;
  /** Set the moment someone claims it, so only the first !pet can win. */
  claimedBy: string | null;
  despawn: ReturnType<typeof setTimeout>;
}

/**
 * "Pet the Floof" — a floof photo drifts across a bottom overlay and the first
 * chatter to type `!pet` wins.
 *
 * Spawns are scheduled on a `base + random(0..random)` timer and only fire while
 * the stream is LIVE (the manual admin trigger bypasses both that and the enable
 * switch, so the overlay can be tested off-stream). A round ends when someone
 * pets the floof or when it gives up after `despawnSeconds`.
 *
 * The animation is entirely client-side; this plugin only broadcasts `spawn`,
 * `pet` and `despawn` to the overlay room.
 */
export function floofPlugin(): Plugin {
  let ctx: ServiceContext;
  let sayText: (channel: string, key: string, vars?: Record<string, string | number>) => Promise<void>;
  let round: Round | null = null;
  let nextAt = 0; // epoch ms the next spawn is due
  let tick: ReturnType<typeof setInterval> | undefined;
  const lastIdlePet = new Map<string, number>();

  /** Schedule the next spawn: base + a random slice of the random window. */
  const rearm = (cfg: FloofConfig) => {
    nextAt = Date.now() + (cfg.baseSeconds + Math.floor(Math.random() * (cfg.randomSeconds + 1))) * 1000;
  };

  /** End the current round without a winner. */
  const despawn = async () => {
    if (!round) return;
    clearTimeout(round.despawn);
    round = null;
    ctx.ws.broadcast(ROOM, 'despawn', {});
    rearm(ctx.floof.getConfig());
  };

  /** Put a floof on screen. `manual` bypasses the enabled + live checks. */
  const spawn = async (manual: boolean): Promise<string | null> => {
    const cfg = ctx.floof.getConfig();
    if (round) return 'A floof is already on screen.';
    if (!manual) {
      if (!cfg.enabled) return 'The game is disabled.';
      if (!(await ctx.stream.isLive())) return 'The stream is not live.';
    }
    const image = await ctx.floof.randomImage();
    if (!image) return 'No floof images have been uploaded yet.';

    round = {
      image: image.name,
      startedAt: Date.now(),
      claimedBy: null,
      despawn: setTimeout(() => void despawn(), cfg.despawnSeconds * 1000),
    };
    ctx.ws.broadcast(ROOM, 'spawn', {
      url: image.url,
      speed: cfg.speed,
      padding: { left: cfg.padLeft, right: cfg.padRight, top: cfg.padTop, bottom: cfg.padBottom },
      despawnSeconds: cfg.despawnSeconds,
    });
    ctx.logger.info({ image: image.name, manual }, 'floof: spawned');
    rearm(cfg); // so the next one is scheduled from now even if this is missed
    return null;
  };

  /**
   * Play the win animation without scoring it (admin test button). If no floof is
   * on screen one is spawned first so there's something to pet; the round is then
   * closed out silently — no DB write, no chat, no achievement.
   */
  const testWin = async (): Promise<string | null> => {
    if (!round) {
      const problem = await spawn(true);
      if (problem) return problem;
      await new Promise((r) => setTimeout(r, 1200)); // let the fade-in finish
    }
    if (round) {
      clearTimeout(round.despawn);
      round = null;
    }
    ctx.ws.broadcast(ROOM, 'pet', { user: 'Test' });
    ctx.logger.info('floof: test win (not scored)');
    return null;
  };

  /** Scheduler heartbeat: spawn when due, enabled, and live. */
  const heartbeat = async () => {
    try {
      const cfg = ctx.floof.getConfig();
      if (!cfg.enabled || round) return;
      if (Date.now() < nextAt) return;
      if (!(await ctx.stream.isLive())) {
        rearm(cfg); // offline: push the window out rather than firing the moment we go live
        return;
      }
      await spawn(false);
    } catch (err) {
      ctx.logger.error({ err }, 'floof: heartbeat failed');
    }
  };

  return {
    name: 'floof',
    version: '0.1.0',

    init(context: ServiceContext) {
      ctx = context;

      const strings: Array<{ key: string; label: string; default: string; placeholders: string[] }> = [
        { key: 'win', label: 'Floof pet (winner)', default: '🐾 {user} pet the floof first! That is {wins} floof {plural} for them.', placeholders: ['user', 'wins', 'plural'] },
        { key: 'idle', label: 'No floof active', default: 'There is no floof to pet right now. Keep watching! 👀', placeholders: [] },
        { key: 'stats', label: 'Stats — line', default: '🐾 {name} has pet the floof {wins} {plural} (rank #{rank}).', placeholders: ['name', 'wins', 'plural', 'rank'] },
        { key: 'noStats', label: 'Stats — no wins', default: '{name} has not pet a floof yet.', placeholders: ['name'] },
        { key: 'unknownUser', label: 'Stats — unknown user', default: 'I don’t know a user called {user}.', placeholders: ['user'] },
        { key: 'setOk', label: 'Setting changed', default: 'Floof {variable} is now {value}.', placeholders: ['variable', 'value'] },
      ];
      for (const s of strings) ctx.text.register({ feature: 'floof', ...s });
      sayText = ctx.text.sayer(ctx.chat, 'floof');

      ctx.commands.registerGroup('pet', {
        description: 'Pet the Floof! When a floof appears on stream, be the first to type "!pet" to win. "!pet stats [user]" shows wins.',
        permission: PermissionLevel.Viewer,

        // Bare "!pet" is a claim on the active floof.
        onUnknown: async (e: CommandEvent) => {
          if (!round || round.claimedBy) {
            // Nothing to pet — rate-limited so it can't be spammed in chat.
            const now = Date.now();
            if (now - (lastIdlePet.get(e.user.id) ?? 0) < IDLE_COOLDOWN_MS) return;
            lastIdlePet.set(e.user.id, now);
            await sayText(e.channel, 'idle');
            return;
          }
          // Claim synchronously BEFORE any await, so two racing !pets can't both win.
          round.claimedBy = e.user.id;
          clearTimeout(round.despawn);
          const current = round;
          round = null;

          await ctx.users.touch(e.user);
          const wins = await ctx.floof.recordWin(e.user.id);
          ctx.ws.broadcast(ROOM, 'pet', { user: e.user.displayName });
          ctx.logger.info({ user: e.user.login, image: current.image, wins }, 'floof: pet');

          await sayText(e.channel, 'win', { user: e.user.displayName, wins, plural: wins === 1 ? 'pet' : 'pets' });
          void ctx.achievements
            .evaluate(e.user.id, 'floof')
            .catch((err) => ctx.logger.error({ err }, 'floof: achievements eval failed'));
        },

        subcommands: {
          stats: {
            description: "Show a player's Pet the Floof wins (defaults to you).",
            usage: '[username]',
            aliases: ['rank'],
            globalCooldownSeconds: 3,
            handler: async (e) => {
              const arg = e.argString.trim();
              let userId = e.user.id;
              let name = e.user.displayName;
              if (arg) {
                const ref = await ctx.users.resolveUserRef(arg);
                if (ref.kind !== 'user') return void (await sayText(e.channel, 'unknownUser', { user: arg }));
                userId = ref.id;
                name = ref.displayName;
              } else {
                await ctx.users.touch(e.user);
              }
              const s = await ctx.floof.statsFor(userId);
              if (!s.wins) return void (await sayText(e.channel, 'noStats', { name }));
              await sayText(e.channel, 'stats', { name, wins: s.wins, plural: s.wins === 1 ? 'time' : 'times', rank: s.rank ?? 0 });
            },
          },

          set: {
            description: `Set a floof variable (admin). Variables: ${Object.keys(FLOOF_VARIABLES).join(', ')}.`,
            usage: '<variable> <value>',
            permission: PermissionLevel.Broadcaster,
            handler: async (e) => {
              const [rawVar, ...rest] = e.args;
              const key = FLOOF_VARIABLES[String(rawVar ?? '').toLowerCase()];
              if (!key) throw new ChatError(`Usage: !pet set <variable> <value> — variables: ${Object.keys(FLOOF_VARIABLES).join(', ')}`);
              const raw = rest.join(' ').trim();
              if (!raw) throw new ChatError(`Give a value for "${rawVar}".`);

              const value = key === 'enabled' ? /^(on|true|yes|1|enabled)$/i.test(raw) : Number(raw);
              if (key !== 'enabled' && !Number.isFinite(value as number)) throw new ChatError(`"${raw}" is not a number.`);
              const updated = await ctx.floof.setConfig({ [key]: value } as Partial<FloofConfig>);
              await sayText(e.channel, 'setOk', { variable: String(rawVar), value: String(updated[key]) });
            },
          },
        },
      });
    },

    start() {
      // Let the admin panel's "Fire now" button drive a spawn (bypasses the
      // enable switch and the live check, so the overlay can be tested anytime).
      ctx.floof.setSpawner(() => spawn(true));
      ctx.floof.setWinTester(testWin);
      rearm(ctx.floof.getConfig());
      tick = setInterval(() => void heartbeat(), TICK_MS);
    },

    stop() {
      if (tick) clearInterval(tick);
      tick = undefined;
      if (round) clearTimeout(round.despawn);
      round = null;
    },
  };
}
