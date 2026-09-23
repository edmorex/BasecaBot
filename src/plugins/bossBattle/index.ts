import type { Plugin } from '../types.js';
import type { ServiceContext } from '../../core/serviceContext.js';
import type { ChatEvent } from '../../core/events.js';
import { BossError, type BossView, type SimAction } from '../../services/bossBattle.js';
import { resolveCombat, type EmoteLists } from '../../services/bossCombat.js';

/** WebSocket room the Boss Battle overlay subscribes to. */
const ROOM = 'boss';
/**
 * Combat is broadcast in frames rather than one message per emote: at high chat
 * volume a message-per-emote would flood the overlay for no visual gain.
 */
const FRAME_MS = 100;
/** How long the defeat/escape outro holds before the overlay is cleared. */
const OUTRO_MS = 6000;
/** Avatar lookups are debounced and batched (Helix takes 100 ids per call). */
const AVATAR_DEBOUNCE_MS = 250;
const AVATAR_BATCH = 100;
/** How long a resolved emote-art lookup is reused. */
const EMOTE_CACHE_MS = 300_000;

/** Someone who has thrown at least one emote during the fight. */
interface Fighter {
  displayName: string;
  avatarUrl: string | null;
  /** Total HP this user has taken off the boss (0 for pure healers/missers). */
  damage: number;
}

/** One pending visual event, flushed to the overlay on the next frame. */
interface FrameEvent {
  id: string;
  name: string;
  damage: number;
  heal: number;
  misses: number;
}

interface Battle {
  boss: BossView;
  /**
   * A mock battle runs the whole presentation but records NOTHING — no
   * scoreboard rows, no achievements, no chat. Real chat still gets to play with
   * it, so emote vulnerabilities can be verified against live viewers safely.
   */
  mock: boolean;
  hp: number;
  lists: EmoteLists;
  /** 'fight' is the only phase where emotes count. */
  phase: 'alert' | 'intel' | 'spawn' | 'fight' | 'over';
  fighters: Map<string, Fighter>;
  /** Last message that landed, per user — the cooldown clock. */
  lastLanded: Map<string, number>;
  /** Who struck the killing blow. */
  killerId: string | null;
  escapeTimer?: ReturnType<typeof setTimeout>;
}

/**
 * Boss Battle — a full-screen raid where chat fights a boss with emotes.
 *
 * A battle runs a five-beat presentation (red alert -> intel dossier -> spawn ->
 * fight -> defeat/escape). The bot drives the timeline and owns all combat
 * arithmetic; the overlay is a renderer that is told which phase it is in.
 *
 * Chat is a PASSIVE input: this plugin registers no commands at all and only
 * listens to messages in the broadcaster's own channel. It is deliberately not a
 * guest-channel feature, so a boss can never be fought in someone else's chat.
 */
export function bossBattlePlugin(): Plugin {
  let ctx: ServiceContext;
  let sayText: (channel: string, key: string, vars?: Record<string, string | number>) => Promise<void>;

  let battle: Battle | null = null;
  /** A battle that has been queued but whose countdown has not elapsed. */
  let pending: { timer: ReturnType<typeof setTimeout>; at: number; bossId: number | null } | null = null;

  // Frame batching
  let frame: FrameEvent[] = [];
  let frameTimer: ReturnType<typeof setTimeout> | undefined;
  // Avatar resolution
  let avatarQueue: string[] = [];
  let avatarTimer: ReturnType<typeof setTimeout> | undefined;
  // Emote art (name -> CDN url) for the intel screen
  let emoteArt: { at: number; map: Map<string, string> } | null = null;

  const channel = () => ctx.config.twitch.channel;

  // ── Emote art ───────────────────────────────────────────────────────────────

  /**
   * Resolve emote names to Twitch CDN image URLs for the intel screen. Channel
   * and global emotes are fetched once and cached; a name we can't resolve comes
   * back without a URL and the overlay renders it as plain text instead.
   */
  const resolveEmoteArt = async (names: string[]): Promise<{ name: string; url: string | null }[]> => {
    if (!names.length) return [];
    if (!emoteArt || Date.now() - emoteArt.at > EMOTE_CACHE_MS) {
      const map = new Map<string, string>();
      try {
        const id = await ctx.stream.broadcasterId();
        const sets = await Promise.all([
          ctx.api.chat.getGlobalEmotes(),
          id ? ctx.api.chat.getChannelEmotes(id) : Promise.resolve([]),
        ]);
        for (const set of sets) {
          for (const e of set) map.set(e.name, e.getFormattedImageUrl('3.0', 'static', 'dark'));
        }
      } catch (err) {
        ctx.logger.warn({ err }, 'boss: emote art lookup failed');
      }
      emoteArt = { at: Date.now(), map };
    }
    return names.map((name) => ({ name, url: emoteArt!.map.get(name) ?? null }));
  };

  // ── Crowd avatars ───────────────────────────────────────────────────────────

  /**
   * Fill in profile pictures for newly-joined fighters. The stored avatar is used
   * when we have one (it's only captured at login, so most chatters won't have
   * it) and the rest are fetched from Helix in ONE batched call rather than one
   * call per chatter.
   */
  const flushAvatars = async () => {
    avatarTimer = undefined;
    const ids = avatarQueue.splice(0, AVATAR_BATCH);
    if (!ids.length || !battle) return;
    const found = new Map<string, string>();
    try {
      const rows = await ctx.storage.prisma.user.findMany({
        where: { id: { in: ids } },
        select: { id: true, avatarUrl: true },
      });
      for (const r of rows) if (r.avatarUrl) found.set(r.id, r.avatarUrl);

      const missing = ids.filter((id) => !found.has(id));
      if (missing.length) {
        const users = await ctx.api.users.getUsersByIds(missing);
        for (const u of users) {
          if (!u.profilePictureUrl) continue;
          found.set(u.id, u.profilePictureUrl);
          // Cache it so the next battle doesn't have to ask Twitch again.
          void ctx.users
            .touch({ id: u.id, login: u.name, displayName: u.displayName, avatarUrl: u.profilePictureUrl })
            .catch(() => {});
        }
      }
    } catch (err) {
      ctx.logger.debug({ err }, 'boss: avatar batch failed');
    }

    const updates: { id: string; name: string; avatarUrl: string | null }[] = [];
    for (const id of ids) {
      const f = battle.fighters.get(id);
      if (!f) continue;
      f.avatarUrl = found.get(id) ?? null;
      updates.push({ id, name: f.displayName, avatarUrl: f.avatarUrl });
    }
    if (updates.length) ctx.ws.broadcast(ROOM, 'crowd', { fighters: updates });
    if (avatarQueue.length) avatarTimer = setTimeout(() => void flushAvatars(), AVATAR_DEBOUNCE_MS);
  };

  const queueAvatar = (id: string) => {
    avatarQueue.push(id);
    if (!avatarTimer) avatarTimer = setTimeout(() => void flushAvatars(), AVATAR_DEBOUNCE_MS);
  };

  // ── Combat ──────────────────────────────────────────────────────────────────

  /** Push this frame's events to the overlay with the authoritative HP. */
  const flushFrame = () => {
    frameTimer = undefined;
    if (!battle || !frame.length) {
      frame = [];
      return;
    }
    ctx.ws.broadcast(ROOM, 'combat', { events: frame, hp: battle.hp, maxHp: battle.boss.hp });
    frame = [];
  };

  const queueFrame = (e: FrameEvent) => {
    frame.push(e);
    if (!frameTimer) frameTimer = setTimeout(flushFrame, FRAME_MS);
  };

  /**
   * Apply one message's worth of combat. Shared by real chat and the admin
   * simulate buttons so both walk exactly the same code path.
   */
  const applyCombat = (
    userId: string,
    displayName: string,
    result: { damage: number; heal: number; misses: number; landed: boolean },
  ) => {
    if (!battle || battle.phase !== 'fight') return;
    const { damage, heal, misses, landed } = result;
    if (!damage && !heal && !misses) return;

    let fighter = battle.fighters.get(userId);
    if (!fighter) {
      // Anyone who throws an emote joins the crowd, even if it did nothing.
      fighter = { displayName, avatarUrl: null, damage: 0 };
      battle.fighters.set(userId, fighter);
      if (battle.fighters.size <= ctx.boss.getConfig().crowdMax) queueAvatar(userId);
    }
    fighter.damage += damage;
    if (landed) battle.lastLanded.set(userId, Date.now());

    // Healing can never push a boss above the health it started with.
    battle.hp = Math.min(battle.boss.hp, Math.max(0, battle.hp - damage + heal));
    queueFrame({ id: userId, name: displayName, damage, heal, misses });

    if (battle.hp <= 0) {
      battle.killerId = userId;
      flushFrame(); // land the final blow before the outro
      void finish(true);
    }
  };

  /** A chat message during a live fight. */
  const onChat = (e: ChatEvent) => {
    // Only the broadcaster's own channel. Another feature (the chat-stats
    // overlay) opens the guest firehose onto this same bus, so this guard is
    // what keeps a boss from being fought in someone else's chat.
    if (e.channel !== channel()) return;
    if (!battle || battle.phase !== 'fight') return;
    const emotes = e.emotes ?? [];
    if (!emotes.length) return;

    const cooldownMs = ctx.boss.getConfig().cooldownSeconds * 1000;
    const onCooldown = Date.now() - (battle.lastLanded.get(e.user.id) ?? 0) < cooldownMs;
    applyCombat(e.user.id, e.user.displayName, resolveCombat(emotes, battle.lists, onCooldown));
  };

  /** slot -> url for every sound that has a file loaded; empty slots are omitted. */
  const soundMap = async (): Promise<Record<string, string>> => {
    const out: Record<string, string> = {};
    try {
      for (const s of await ctx.boss.listSounds()) if (s.url) out[s.slot] = s.url;
    } catch (err) {
      ctx.logger.warn({ err }, 'boss: could not read the sound library');
    }
    return out;
  };

  // ── Battle lifecycle ────────────────────────────────────────────────────────

  /** Run the five-beat presentation and hand control to the fight. */
  const begin = async (bossId: number | null, mock: boolean): Promise<void> => {
    const cfg = ctx.boss.getConfig();
    const boss = await ctx.boss.pickBoss(bossId);

    battle = {
      boss,
      mock,
      hp: boss.hp,
      lists: {
        // The public/private split is purely presentational — both hurt.
        hurt: new Set([...boss.emotesPublic, ...boss.emotesPrivate]),
        heal: new Set(boss.emotesHeal),
      },
      phase: 'alert',
      fighters: new Map(),
      lastLanded: new Map(),
      killerId: null,
    };

    // 1. Red alert. Sound urls ride along with it (rather than being fetched by
    //    the overlay at load) so swapping a sound in the admin panel takes effect
    //    on the very next battle without refreshing the Browser Source.
    ctx.ws.broadcast(ROOM, 'alert', {
      seconds: cfg.alertSeconds,
      sounds: await soundMap(),
      volumeSfx: cfg.volumeSfx,
      volumeBgm: cfg.volumeBgm,
    });
    if (!mock) await sayText(channel(), 'warning').catch(() => {});
    await wait(cfg.alertSeconds * 1000);
    if (!battle) return; // cancelled mid-sequence

    // 2. Intel dossier. Private vulnerabilities are never named, only hinted at.
    battle.phase = 'intel';
    ctx.ws.broadcast(ROOM, 'intel', {
      name: boss.name,
      description: boss.description,
      imageUrl: boss.imageUrl,
      seconds: cfg.intelSeconds,
      vulnerabilities: await resolveEmoteArt(boss.emotesPublic),
      hasSecret: boss.emotesPrivate.length > 0,
    });
    await wait(cfg.intelSeconds * 1000);
    if (!battle) return;

    // 3. Spawn — the overlay owns the animation from here, so it gets everything
    //    it needs to run taunts and style rotation without further round-trips.
    battle.phase = 'spawn';
    ctx.ws.broadcast(ROOM, 'spawn', {
      name: boss.name,
      imageUrl: boss.imageUrl,
      size: boss.size,
      hp: boss.hp,
      maxHp: boss.hp,
      speedFull: boss.speedFull,
      speedNearDeath: boss.speedNearDeath,
      styles: boss.styles,
      openingTaunt: boss.tauntOpening,
      taunts: boss.tauntBattle,
      escapeSeconds: boss.escapeSeconds,
      config: {
        tauntEverySeconds: cfg.tauntEverySeconds,
        tauntHoldSeconds: cfg.tauntHoldSeconds,
        dartSeconds: cfg.dartSeconds,
        spinRadius: cfg.spinRadius,
        spinSeconds: cfg.spinSeconds,
        crowdMax: cfg.crowdMax,
        volumeSfx: cfg.volumeSfx,
        volumeBgm: cfg.volumeBgm,
      },
    });

    // 4. Fight.
    battle.phase = 'fight';
    battle.escapeTimer = setTimeout(() => void finish(false), boss.escapeSeconds * 1000);
    ctx.logger.info({ boss: boss.name, hp: boss.hp, mock }, 'boss: battle started');
  };

  /** End the battle, either defeated (`won`) or escaped. */
  const finish = async (won: boolean): Promise<void> => {
    const b = battle;
    if (!b || b.phase === 'over') return;
    b.phase = 'over';
    if (b.escapeTimer) clearTimeout(b.escapeTimer);

    // Credit only chatters who actually took health off it — healers were on the
    // other side, and pure missers never landed a blow.
    const attackers = [...b.fighters.entries()].filter(([, f]) => f.damage > 0);
    const killer = b.killerId ? b.fighters.get(b.killerId)?.displayName ?? null : null;

    if (won) {
      ctx.ws.broadcast(ROOM, 'defeated', { name: b.boss.name, taunt: b.boss.tauntDeath, killer, count: attackers.length });
    } else {
      ctx.ws.broadcast(ROOM, 'escaped', { name: b.boss.name, taunt: b.boss.tauntEscape, hp: b.hp });
    }

    if (!b.mock) {
      try {
        if (won) {
          await ctx.boss.recordDefeat(attackers.map(([id]) => id), b.killerId);
          const names = attackers.map(([, f]) => f.displayName);
          await sayText(channel(), 'defeated', {
            boss: b.boss.name,
            count: names.length,
            killer: killer ?? 'someone',
            names: names.slice(0, 15).join(', ') + (names.length > 15 ? ', …' : ''),
          });
          // Evaluated AFTER the scoreboard write — the bus awaits handlers
          // concurrently, so an event-driven hook would race it and read stale counts.
          for (const [id] of attackers) {
            void ctx.achievements.evaluate(id, 'boss').catch((err) => ctx.logger.error({ err }, 'boss: achievements eval failed'));
          }
        } else {
          await sayText(channel(), 'escaped', { boss: b.boss.name, hp: b.hp });
        }
      } catch (err) {
        ctx.logger.error({ err }, 'boss: could not finish battle cleanly');
      }
    }

    ctx.logger.info({ boss: b.boss.name, won, fighters: b.fighters.size, mock: b.mock }, 'boss: battle over');
    setTimeout(() => {
      if (battle === b) {
        battle = null;
        ctx.ws.broadcast(ROOM, 'clear', {});
      }
    }, OUTRO_MS);
  };

  /** Queue a battle behind the countdown, so the streamer can step away first. */
  const start = async (bossId: number | null, delaySeconds: number, mock = false): Promise<string | null> => {
    if (battle) return 'A battle is already in progress.';
    if (pending) return 'A battle is already counting down.';
    try {
      // Fail fast on a missing/artless boss instead of surprising chat later.
      await ctx.boss.pickBoss(bossId);
    } catch (e) {
      return e instanceof BossError ? e.message : 'Could not start the battle.';
    }
    if (delaySeconds <= 0) {
      void begin(bossId, mock).catch((err) => {
        ctx.logger.error({ err }, 'boss: battle failed to start');
        battle = null;
      });
      return null;
    }
    pending = {
      bossId,
      at: Date.now() + delaySeconds * 1000,
      timer: setTimeout(() => {
        pending = null;
        void begin(bossId, mock).catch((err) => {
          ctx.logger.error({ err }, 'boss: battle failed to start');
          battle = null;
        });
      }, delaySeconds * 1000),
    };
    ctx.logger.info({ bossId, delaySeconds, mock }, 'boss: battle queued');
    return null;
  };

  /** Cancel a queued battle (or abandon a running one). */
  const cancel = async (): Promise<string | null> => {
    if (pending) {
      clearTimeout(pending.timer);
      pending = null;
      return null;
    }
    if (battle) {
      const b = battle;
      b.phase = 'over';
      if (b.escapeTimer) clearTimeout(b.escapeTimer);
      battle = null;
      ctx.ws.broadcast(ROOM, 'clear', {});
      return null;
    }
    return 'There is no battle to cancel.';
  };

  /** Admin simulate: spawn a mock battle immediately. */
  const simSpawn = async (bossId: number | null): Promise<string | null> => start(bossId, 0, true);

  /**
   * Admin simulate: stand in for a chatter hitting, missing or healing. Routed
   * through the same `applyCombat` as real chat, so what you see on the overlay
   * is what a real message would do.
   */
  const simAct = async (action: SimAction): Promise<string | null> => {
    if (!battle) return 'There is no battle running — spawn one first.';
    if (battle.phase !== 'fight') return 'The battle has not reached the fight yet.';
    applyCombat('sim-tester', 'Tester', {
      damage: action === 'hit' ? 1 : 0,
      heal: action === 'heal' ? 1 : 0,
      misses: action === 'miss' ? 1 : 0,
      landed: action !== 'miss',
    });
    return null;
  };

  return {
    name: 'bossBattle',
    version: '0.1.0',

    init(context: ServiceContext) {
      ctx = context;

      const strings = [
        { key: 'warning', label: 'Boss incoming', default: '🚨 WARNING! A BOSS IS APPROACHING! Ready your emotes — hit it with what it fears!', placeholders: [] },
        { key: 'defeated', label: 'Boss defeated', default: '⚔️ {boss} has been DEFEATED by {count} chatters! Killing blow: {killer}. 🎉 {names}', placeholders: ['boss', 'count', 'killer', 'names'] },
        { key: 'escaped', label: 'Boss escaped', default: '💀 {boss} ESCAPED with {hp} HP left! Chat was not strong enough…', placeholders: ['boss', 'hp'] },
      ];
      for (const s of strings) ctx.text.register({ feature: 'boss', ...s });
      sayText = ctx.text.sayer(ctx.chat, 'boss');

      // Passive consumer: no commands, and NOT registered as a guest feature.
      ctx.bus.on('chat', (e) => onChat(e));
    },

    start() {
      ctx.boss.setStarter((bossId, delay) => start(bossId, delay));
      ctx.boss.setCanceller(cancel);
      ctx.boss.setSimulators(simSpawn, simAct);
    },

    stop() {
      if (pending) clearTimeout(pending.timer);
      pending = null;
      if (battle?.escapeTimer) clearTimeout(battle.escapeTimer);
      battle = null;
      if (frameTimer) clearTimeout(frameTimer);
      if (avatarTimer) clearTimeout(avatarTimer);
      frame = [];
      avatarQueue = [];
    },
  };
}

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
