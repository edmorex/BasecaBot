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
/** How long the red "A BOSS FLOOF APPROACHES!" alert plays before the boss lands. */
const BOSS_ALERT_MS = 4000;
/**
 * Per-user cooldown between hits on a boss. Repeats ARE allowed — one determined
 * chatter can in principle solo a boss — but only a few times before it escapes.
 */
const BOSS_PET_COOLDOWN_MS = 30_000;

/** The currently-visible floof, if any. */
interface Round {
  image: string;
  startedAt: number;
  /** Set the moment someone claims it, so only the first !pet can win (normal rounds). */
  claimedBy: string | null;
  despawn: ReturnType<typeof setTimeout>;
  /** Boss battles need many chatters; normal rounds end on the first !pet. */
  boss: boolean;
  /** How many pets are needed to defeat the boss (its starting life). */
  needed: number;
  /** Pets landed so far; the boss dies when this reaches `needed`. */
  hits: number;
  /** Everyone who has landed at least one hit — all of them get the credit. */
  participants: Map<string, string>; // userId -> displayName
  /** Last hit per user, enforcing BOSS_PET_COOLDOWN_MS between their pets. */
  lastPet: Map<string, number>;
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

  /** End the current round without a winner (the boss escapes). */
  const despawn = async () => {
    if (!round) return;
    const wasBoss = round.boss;
    clearTimeout(round.despawn);
    round = null;
    ctx.ws.broadcast(ROOM, 'despawn', { boss: wasBoss });
    if (wasBoss) await sayText(ctx.config.twitch.channel, 'bossEscaped').catch(() => {});
    rearm(ctx.floof.getConfig());
  };

  /**
   * Put a floof on screen. `manual` bypasses the enabled + live checks. A boss
   * spawn first plays a red alert on the overlay, then reveals the boss — pets
   * only count once it has actually landed.
   */
  const spawn = async (manual: boolean, boss = false): Promise<string | null> => {
    const cfg = ctx.floof.getConfig();
    if (round) return 'A floof is already on screen.';
    if (!manual) {
      if (!cfg.enabled) return 'The game is disabled.';
      if (!(await ctx.stream.isLive())) return 'The stream is not live.';
    }
    const image = await ctx.floof.randomImage(boss);
    if (!image) return boss ? 'No BOSS floof images have been uploaded yet.' : 'No floof images have been uploaded yet.';

    if (boss) {
      ctx.ws.broadcast(ROOM, 'boss-alert', { seconds: BOSS_ALERT_MS / 1000 });
      await sayText(ctx.config.twitch.channel, 'bossIncoming');
      await new Promise((r) => setTimeout(r, BOSS_ALERT_MS));
      if (round) return 'A floof is already on screen.'; // raced while alerting
    }

    const needed = boss ? Math.max(1, cfg.bossPets) : 1;
    const despawnSeconds = boss ? cfg.bossDespawnSeconds : cfg.despawnSeconds;
    round = {
      image: image.name,
      startedAt: Date.now(),
      claimedBy: null,
      despawn: setTimeout(() => void despawn(), despawnSeconds * 1000),
      boss,
      needed,
      hits: 0,
      participants: new Map(),
      lastPet: new Map(),
    };
    ctx.ws.broadcast(ROOM, 'spawn', {
      url: image.url,
      speed: cfg.speed,
      padding: { left: cfg.padLeft, right: cfg.padRight, top: cfg.padTop, bottom: cfg.padBottom },
      despawnSeconds,
      taunts: ctx.floof.getTaunts(),
      boss,
      needed,
    });
    ctx.logger.info({ image: image.name, manual, boss, needed }, 'floof: spawned');
    rearm(cfg); // so the next one is scheduled from now even if this is missed
    return null;
  };

  /**
   * Stand in for a chatter's `!pet` (admin test button). Scores NOTHING — no DB
   * write, no chat, no achievement — so a battle can be stepped through without
   * polluting the scoreboard. Against a boss each click lands one hit, so
   * clicking repeatedly walks its life bar down to a defeat; against a normal
   * floof a single click plays the win animation.
   */
  const simulatePet = async (): Promise<string | null> => {
    if (!round) return 'There is no floof on screen — fire one first.';

    if (round.boss) {
      round.hits++;
      const remaining = Math.max(0, round.needed - round.hits);
      // Deliberately NOT added to `participants`, so a simulated kill credits nobody.
      ctx.ws.broadcast(ROOM, 'boss-hit', { user: 'Test', remaining, needed: round.needed });
      if (remaining > 0) return null;
      clearTimeout(round.despawn);
      round = null;
      ctx.ws.broadcast(ROOM, 'boss-defeated', { count: 0 });
      ctx.logger.info('floof: simulated boss defeat (not scored)');
      return null;
    }

    clearTimeout(round.despawn);
    round = null;
    ctx.ws.broadcast(ROOM, 'pet', { user: 'Test' });
    ctx.logger.info('floof: simulated pet (not scored)');
    return null;
  };

  /** Spawn a BOSS on demand (admin button) — alert, then the boss itself. */
  const spawnBoss = async (): Promise<string | null> => spawn(true, true);

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
      // Roll for a boss battle; falls back to a normal floof if no boss art exists.
      const boss = Math.random() * 100 < cfg.bossChance;
      const problem = await spawn(false, boss);
      if (problem && boss) await spawn(false, false);
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
        { key: 'bossIncoming', label: 'Boss — incoming alert', default: '🚨 A BOSS FLOOF APPROACHES! Everyone type !pet to bring it down!', placeholders: [] },
        { key: 'bossDefeated', label: 'Boss — defeated', default: '⚔️ BOSS FLOOF DEFEATED by {count} chatters! {names}', placeholders: ['count', 'names'] },
        { key: 'bossEscaped', label: 'Boss — escaped', default: '💀 FAILURE! BOSS FLOOF ESCAPED! Chat was not strong enough…', placeholders: [] },
      ];
      for (const s of strings) ctx.text.register({ feature: 'floof', ...s });
      sayText = ctx.text.sayer(ctx.chat, 'floof');

      ctx.commands.registerGroup('pet', {
        description: 'Pet the Floof! When a floof appears on stream, be the first to type "!pet" to win. "!pet stats [user]" shows wins.',
        permission: PermissionLevel.Viewer,

        // Bare "!pet" is a claim on the active floof (or a hit on the boss).
        onUnknown: async (e: CommandEvent) => {
          if (!round || round.claimedBy) {
            // Nothing to pet — rate-limited so it can't be spammed in chat.
            const now = Date.now();
            if (now - (lastIdlePet.get(e.user.id) ?? 0) < IDLE_COOLDOWN_MS) return;
            lastIdlePet.set(e.user.id, now);
            await sayText(e.channel, 'idle');
            return;
          }

          // ── Boss battle: chip its life down; repeats allowed on a cooldown ──
          if (round.boss) {
            const now = Date.now();
            if (now - (round.lastPet.get(e.user.id) ?? 0) < BOSS_PET_COOLDOWN_MS) return; // still catching their breath
            round.lastPet.set(e.user.id, now);
            round.participants.set(e.user.id, e.user.displayName);
            round.hits++;
            const remaining = Math.max(0, round.needed - round.hits);
            ctx.ws.broadcast(ROOM, 'boss-hit', { user: e.user.displayName, remaining, needed: round.needed });
            if (remaining > 0) {
              await ctx.users.touch(e.user);
              return; // keep chat quiet until it's actually down
            }

            // Defeated — credit everyone who joined in.
            round.claimedBy = e.user.id; // lock so a straggler can't double-fire
            clearTimeout(round.despawn);
            const party = [...round.participants.entries()];
            round = null;

            for (const [id, displayName] of party) {
              await ctx.users.touch({ id, login: displayName.toLowerCase(), displayName }).catch(() => {});
            }
            await ctx.floof.recordBossWin(party.map(([id]) => id));
            ctx.ws.broadcast(ROOM, 'boss-defeated', { count: party.length });
            ctx.logger.info({ participants: party.length }, 'floof: boss defeated');

            const names = party.map(([, n]) => n);
            await sayText(e.channel, 'bossDefeated', {
              count: names.length,
              names: names.slice(0, 15).join(', ') + (names.length > 15 ? ', …' : ''),
            });
            for (const [id] of party) {
              void ctx.achievements
                .evaluate(id, 'floof')
                .catch((err) => ctx.logger.error({ err }, 'floof: achievements eval failed'));
            }
            return;
          }

          // ── Normal round: first !pet wins ─────────────────────────────────
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
      ctx.floof.setPetSimulator(simulatePet);
      ctx.floof.setBossSpawner(spawnBoss);
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
