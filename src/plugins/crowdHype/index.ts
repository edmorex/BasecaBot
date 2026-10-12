import type { Plugin } from '../types.js';
import type { ServiceContext } from '../../core/serviceContext.js';
import type { ChatEvent } from '../../core/events.js';
import { emoteImageUrl } from '../../services/bossBattle.js';
import { CrowdTracker, excitementLevel, assignRows, type RowSlot } from './crowd.js';

/** WebSocket room the Crowd Hype overlay subscribes to. */
const ROOM = 'crowd';
/** How often the roster and excitement level are pushed to the overlay. */
const TICK_MS = 300;
/** Helix takes 100 ids per call; avatar lookups are batched and debounced. */
const AVATAR_BATCH = 100;
const AVATAR_DEBOUNCE_MS = 400;
/** Most emotes forwarded per chatter per tick, so one spammer cannot flood it. */
const MAX_SPEW_PER_USER = 6;

/**
 * Twitch global emote ids the simulator throws, so the spew can actually be seen
 * while tuning the settings.
 *
 * Every one of these was checked against the CDN rather than recalled: two ids
 * that "everyone knows" (86, 88) turned out to 404. Should Twitch retire one
 * later the overlay drops any image that fails to load, so it degrades to nothing
 * rather than a broken-image icon.
 */
const SIM_EMOTE_IDS = [
  '25', '33', '41', '52', '245', '354', '360', '425618',
  '30259', '64138', '58765', '81274', '55338', '305954156',
];

/** What we know about one chatter on screen. */
interface Fighter {
  name: string;
  avatarUrl: string | null;
}

/**
 * Crowd Hype — chat rendered as an MST3K-style audience along the bottom of the
 * screen, whose energy tracks how fast chat is moving.
 *
 * A guest-channel feature that `consumesRawChat`: while the bot is connected to a
 * guest, the adapter forwards that channel's chat here and the crowd is driven by
 * it, so the overlay can front a collab. Like the stats overlay it is purely an
 * observer — it registers no commands and never speaks.
 *
 * The bot owns all of the arithmetic (rate, excitement level, who stands where)
 * and the overlay owns the drawing. Settings ride along with every tick so a
 * knob moved in the panel shows up immediately, and so an overlay that connects
 * late is correct on its first frame without asking for anything.
 */
export function crowdHypePlugin(): Plugin {
  let ctx: ServiceContext;
  const tracker = new CrowdTracker();
  const members = new Map<string, Fighter>();
  let slots = new Map<string, RowSlot>();
  let tick: ReturnType<typeof setInterval> | undefined;

  /** Emotes seen since the last tick, per chatter. */
  let pendingSpew = new Map<string, string[]>();
  /** Silhouette filenames, refreshed on a slow cadence (uploads are rare). */
  let silhouettes: string[] = [];
  /** Seat -> silhouette url, for seats the broadcaster has pinned. */
  let seatArt: Record<string, string> = {};
  let silhouettesAt = 0;
  /** Which clear request we have already acted on. */
  let handledClear = 0;

  // Avatars: resolved once per chatter and kept in memory.
  const avatars = new Map<string, string | null>();
  let avatarQueue: string[] = [];
  let avatarTimer: ReturnType<typeof setTimeout> | undefined;

  /** The channel the crowd is reading: the guest if we are in one, else home. */
  const focusChannel = () => ctx.guests.guestChannel() ?? ctx.config.twitch.channel;

  // ── Avatars ─────────────────────────────────────────────────────────────────

  /**
   * Fill in profile pictures for chatters we have not seen before.
   *
   * Stored avatars are used when we have them and the rest come from Helix in one
   * batched call. Results are written back to our own user records ONLY for the
   * broadcaster's channel: in a guest channel these are somebody else's viewers,
   * and quietly creating user rows for them is not this overlay's business.
   */
  const flushAvatars = async () => {
    avatarTimer = undefined;
    const ids = avatarQueue.splice(0, AVATAR_BATCH);
    if (!ids.length) return;
    const home = focusChannel() === ctx.config.twitch.channel;
    try {
      const rows = await ctx.storage.prisma.user.findMany({
        where: { id: { in: ids } },
        select: { id: true, avatarUrl: true },
      });
      for (const r of rows) if (r.avatarUrl) avatars.set(r.id, r.avatarUrl);

      const missing = ids.filter((id) => !avatars.get(id));
      if (missing.length) {
        for (const u of await ctx.api.users.getUsersByIds(missing)) {
          avatars.set(u.id, u.profilePictureUrl ?? null);
          if (home && u.profilePictureUrl) {
            void ctx.users
              .touch({ id: u.id, login: u.name, displayName: u.displayName, avatarUrl: u.profilePictureUrl })
              .catch(() => {});
          }
        }
      }
    } catch (err) {
      ctx.logger.debug({ err }, 'crowd: avatar batch failed');
    }
    for (const id of ids) {
      if (!avatars.has(id)) avatars.set(id, null); // remember the miss, don't re-ask
      const m = members.get(id);
      if (m) m.avatarUrl = avatars.get(id) ?? null;
    }
    if (avatarQueue.length) avatarTimer = setTimeout(() => void flushAvatars(), AVATAR_DEBOUNCE_MS);
  };

  const queueAvatar = (id: string) => {
    if (avatars.has(id) || avatarQueue.includes(id) || id.startsWith('sim-')) return;
    avatarQueue.push(id);
    if (!avatarTimer) avatarTimer = setTimeout(() => void flushAvatars(), AVATAR_DEBOUNCE_MS);
  };

  // ── Chat ────────────────────────────────────────────────────────────────────

  /** Remember a chatter, assigning them a silhouette the first time we see them. */
  const seen = (userId: string, name: string): Fighter => {
    let m = members.get(userId);
    if (!m) {
      m = { name, avatarUrl: avatars.get(userId) ?? null };
      members.set(userId, m);
      queueAvatar(userId);
    }
    m.name = name;
    return m;
  };

  const onChat = (e: ChatEvent) => {
    if (e.channel !== focusChannel()) return;
    if (e.user.login === ctx.config.twitch.botUsername) return; // the bot is not in the crowd
    const emotes = e.emotes ?? [];
    const count = emotes.reduce((n, em) => n + Math.max(0, em.count), 0);
    tracker.add({ ts: e.ts, userId: e.user.id, name: e.user.displayName, emotes: count });
    seen(e.user.id, e.user.displayName);

    if (!emotes.length || !ctx.crowd.getConfig().emoteSpew) return;
    // Emote ids come straight off the IRC tags, so the art needs no lookup.
    const urls = pendingSpew.get(e.user.id) ?? [];
    for (const em of emotes) {
      for (let i = 0; i < Math.max(1, em.count) && urls.length < MAX_SPEW_PER_USER; i++) {
        urls.push(emoteImageUrl(em.id));
      }
    }
    pendingSpew.set(e.user.id, urls);
  };

  // ── Simulation ──────────────────────────────────────────────────────────────

  /**
   * Inject synthetic chat so the configuration can be judged without an audience.
   * Fake chatters get ids prefixed `sim-`, which keeps them out of avatar lookups
   * and makes them obvious in the logs; nothing is recorded anywhere.
   */
  const simulate = (now: number, elapsedMs: number) => {
    const cfg = ctx.crowd.getConfig();
    const chatters = Math.max(1, cfg.simChatters);
    const msgs = poisson((cfg.simChatRate * elapsedMs) / 1000);
    const emotes = poisson((cfg.simEmoteRate * elapsedMs) / 1000);
    if (!msgs && !emotes) return;

    // Spread the emotes over the messages that carried them.
    const perMsg = msgs > 0 ? Math.floor(emotes / msgs) : 0;
    let left = msgs > 0 ? emotes % msgs : emotes;
    for (let i = 0; i < Math.max(msgs, emotes > 0 ? 1 : 0); i++) {
      const n = Math.floor(Math.random() * chatters);
      const userId = 'sim-' + n;
      const name = 'Chatter' + (n + 1);
      const carried = Math.max(0, perMsg + (left-- > 0 ? 1 : 0));
      tracker.add({ ts: now, userId, name, emotes: carried });
      seen(userId, name);
      // Real emote art, so the spew is visible while the settings are tuned.
      if (carried > 0 && cfg.emoteSpew) {
        const urls = pendingSpew.get(userId) ?? [];
        for (let k = 0; k < carried && urls.length < MAX_SPEW_PER_USER; k++) {
          urls.push(emoteImageUrl(SIM_EMOTE_IDS[Math.floor(Math.random() * SIM_EMOTE_IDS.length)]!));
        }
        pendingSpew.set(userId, urls);
      }
    }
  };

  // ── Tick ────────────────────────────────────────────────────────────────────

  const refreshSilhouettes = async () => {
    if (Date.now() - silhouettesAt < 15_000) return;
    silhouettesAt = Date.now();
    // Resolved independently: a failure reading the assignments must not also
    // blank the silhouette library and leave the whole crowd shapeless.
    try {
      silhouettes = (await ctx.crowd.listImages()).map((i: { url: string }) => i.url);
    } catch {
      silhouettes = [];
    }
    try {
      seatArt = await ctx.crowd.resolveSeatArt();
    } catch {
      seatArt = {};
    }
  };

  let lastTickAt = 0;

  const heartbeat = () => {
    const cfg = ctx.crowd.getConfig();
    const live = ctx.crowd.getLive();
    const now = Date.now();
    const elapsed = lastTickAt ? now - lastTickAt : TICK_MS;
    lastTickAt = now;
    void refreshSilhouettes();

    // A new clear request empties the overlay and forgets everyone on screen.
    if (live.clearedAt > handledClear) {
      handledClear = live.clearedAt;
      tracker.clear();
      members.clear();
      slots = new Map();
      pendingSpew = new Map();
      ctx.ws.broadcast(ROOM, 'clear', {});
    }

    if (!cfg.enabled) {
      // Disabled means nothing on screen, whatever chat is doing.
      ctx.ws.broadcast(ROOM, 'crowd', { enabled: false, members: [] });
      return;
    }
    if (live.sim) simulate(now, elapsed);
    if (now < live.pausedUntil) return; // cleared/paused: let the overlay sit still

    const windowMs = cfg.rateWindowSeconds * 1000;
    // Presence outlasts activity: a chatter stays in the crowd for this long after
    // their last message, even though their score drops to zero much sooner.
    tracker.prune(now, windowMs, windowMs * Math.max(1, cfg.survivalWindows));
    const rate = tracker.rate(now, windowMs);
    const quiesced = now < live.quiescedUntil;
    const level = quiesced ? 1 : excitementLevel(rate, cfg.thresholds);

    const ranked = tracker.ranking(now, windowMs);
    slots = assignRows(ranked, slots, {
      rows: cfg.rows,
      perRow: cfg.perRow,
      debounceMs: cfg.rowDebounceSeconds * 1000,
      now,
    });

    // Only the chatter travels between positions now — the silhouette belongs to
    // the seat, so the overlay picks the art per position from the whole library.
    const roster = ranked
      .filter((m) => slots.has(m.userId))
      .map((m) => {
        const f = seen(m.userId, m.name);
        return { id: m.userId, name: m.name, row: slots.get(m.userId)!.row, avatarUrl: f.avatarUrl };
      });

    // Forget anyone who has dropped off, so the maps track the crowd not history.
    for (const id of [...members.keys()]) if (!slots.has(id)) members.delete(id);

    const spews = [...pendingSpew.entries()]
      .filter(([id]) => slots.has(id))
      .map(([id, urls]) => ({ id, urls }));
    pendingSpew = new Map();

    ctx.ws.broadcast(ROOM, 'crowd', {
      enabled: true,
      channel: focusChannel(),
      level,
      rate: Math.round(rate * 100) / 100,
      mode: live.mode,
      quiesced,
      sim: live.sim,
      members: roster,
      spews: cfg.emoteSpew ? spews : [],
      // Sent every tick on purpose: a panel change lands on the next frame and an
      // overlay that connects late is correct immediately, with no handshake.
      config: {
        rows: cfg.rows,
        rowSpacing: cfg.rowSpacing,
        perRow: cfg.perRow,
        rowScale: cfg.rowScale,
        silhouetteHeight: cfg.silhouetteHeight,
        avatarSize: cfg.avatarSize,
        glow: cfg.glow,
        glowColor: cfg.glowColor,
        silhouettes,
        seatArt,
        mirrorMode: cfg.mirrorMode,
        emoteSpew: cfg.emoteSpew,
        spewSpeed: cfg.spewSpeed,
        spewSize: cfg.spewSize,
        spewSeconds: cfg.spewSeconds,
        anim: live.mode === 'slow' ? cfg.calm : cfg.levels[level - 1],
      },
    });
  };

  return {
    name: 'crowdHype',
    version: '0.1.0',

    init(context: ServiceContext) {
      ctx = context;
      // Declaring consumesRawChat is what opens the guest chat firehose to us.
      ctx.guests.registerFeature({ id: 'crowd-hype', consumesRawChat: true });
      ctx.bus.on('chat', (e) => onChat(e));
    },

    start() {
      tick = setInterval(heartbeat, TICK_MS);
    },

    stop() {
      if (tick) clearInterval(tick);
      tick = undefined;
      if (avatarTimer) clearTimeout(avatarTimer);
      avatarTimer = undefined;
      avatarQueue = [];
      tracker.clear();
      members.clear();
      slots = new Map();
      pendingSpew = new Map();
    },
  };
}

/** A small Poisson draw, so simulated chat arrives in bursts rather than evenly. */
function poisson(mean: number): number {
  if (mean <= 0) return 0;
  if (mean > 20) return Math.max(0, Math.round(mean + Math.sqrt(mean) * (Math.random() * 2 - 1)));
  const limit = Math.exp(-mean);
  let k = 0;
  let p = Math.random();
  while (p > limit) {
    p *= Math.random();
    k++;
  }
  return k;
}
