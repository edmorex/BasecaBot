import type { Plugin } from '../types.js';
import type { ServiceContext } from '../../core/serviceContext.js';
import { InsufficientPointsError } from '../../services/points.js';
import { PermissionLevel } from '../../core/events.js';

const CURRENCY = 'BascaPoints';
const PAYOUT_INTERVAL_MS = 5 * 60 * 1000; // every 5 minutes
const SUB_POINTS = 30; // subscribers (and VIP/Mod/Broadcaster/Admin) per payout
const NONSUB_POINTS = 25; // everyone else per payout
const NONSUB_CAP = 3000; // non-subscribers stop accruing past this

/**
 * The loyalty economy. Points accrue ONLY by being present in chat while the
 * channel is live: every 5 minutes, EVERY user connected to chat (including
 * lurkers, via Twitch's Get Chatters endpoint) is paid out — 30 for
 * subscribers/VIPs/mods/broadcaster/admins, 25 for everyone else (capped at
 * 3000 for non-subscribers). No points for chatting per-message, subs, bits, or
 * events. Mods/broadcaster can also grant points directly with !addpoints.
 *
 * Requires broadcaster-token scopes: moderator:read:chatters, channel:read:vips,
 * channel:read:subscriptions, moderation:read.
 */
export function pointsPlugin(): Plugin {
  let ctx: ServiceContext;
  let timer: ReturnType<typeof setInterval> | undefined;
  let broadcasterId: string | undefined;

  async function getBroadcasterId(): Promise<string | undefined> {
    if (broadcasterId) return broadcasterId;
    const u = await ctx.api.users.getUserByName(ctx.config.twitch.broadcasterUsername);
    broadcasterId = u?.id;
    return broadcasterId;
  }

  /** Fetch a set of user ids from a paginated list, or empty on failure (e.g. missing scope). */
  async function idSet<T>(fetch: () => Promise<T[]>, getId: (x: T) => string, label: string): Promise<Set<string>> {
    try {
      return new Set((await fetch()).map(getId));
    } catch (err) {
      ctx.logger.warn({ err, list: label }, 'points: tier list fetch failed; treating as empty');
      return new Set();
    }
  }

  /** Pay out to everyone present in chat, but only while the channel is live. */
  async function payout(): Promise<void> {
    const channel = ctx.config.twitch.channels[0] ?? 'unknown';
    const bid = await getBroadcasterId();
    if (!bid) {
      ctx.logger.error({ user: ctx.config.twitch.broadcasterUsername }, 'points: broadcaster not found');
      return;
    }

    let live: boolean;
    try {
      live = (await ctx.api.streams.getStreamByUserId(bid)) !== null;
    } catch (err) {
      ctx.logger.error({ err }, 'points: live-check failed; skipping payout');
      return;
    }
    if (!live) return;

    // Everyone currently connected to chat (includes lurkers).
    let chatters: { userId: string; userName: string; userDisplayName: string }[];
    try {
      chatters = await ctx.api.chat.getChattersPaginated(bid).getAll();
    } catch (err) {
      ctx.logger.error({ err }, 'points: getChatters failed — is moderator:read:chatters on the broadcaster token?');
      return;
    }
    if (chatters.length === 0) return;

    // Who qualifies for the higher tier (30): subs, mods, VIPs, broadcaster, bot admins.
    const [subs, mods, vips] = await Promise.all([
      idSet(() => ctx.api.subscriptions.getSubscriptionsPaginated(bid).getAll(), (s) => s.userId, 'subscribers'),
      idSet(() => ctx.api.moderation.getModeratorsPaginated(bid).getAll(), (m) => m.userId, 'moderators'),
      idSet(() => ctx.api.channels.getVipsPaginated(bid).getAll(), (v) => v.id, 'vips'),
    ]);
    const admins = ctx.config.twitch.admins;
    const botLogin = ctx.config.twitch.botUsername;

    let awarded = 0;
    for (const ch of chatters) {
      if (ch.userName.toLowerCase() === botLogin) continue; // don't pay the bot itself
      const higher =
        ch.userId === bid || subs.has(ch.userId) || mods.has(ch.userId) || vips.has(ch.userId) || admins.includes(ch.userName.toLowerCase());
      try {
        await ctx.users.touch({ id: ch.userId, login: ch.userName, displayName: ch.userDisplayName });
        if (higher) await ctx.points.award(ch.userId, channel, SUB_POINTS);
        else await ctx.points.awardCapped(ch.userId, channel, NONSUB_POINTS, NONSUB_CAP);
        awarded++;
      } catch (err) {
        ctx.logger.error({ err, user: ch.userName }, 'points: award failed');
      }
    }
    ctx.logger.info({ awarded }, 'points payout');
  }

  return {
    name: 'points',
    version: '0.3.0',

    init(context: ServiceContext) {
      ctx = context;

      // ── Commands ──────────────────────────────────────────────────────────
      ctx.commands.register(
        'points',
        async (e) => {
          if (e.args[0]?.toLowerCase() === 'top') {
            const board = await ctx.points.leaderboard(e.channel, 5);
            const rendered = board.map((r, i) => `${i + 1}. ${r.displayName} (${r.balance})`).join(', ');
            await ctx.chat.say(e.channel, `Top ${CURRENCY}: ${rendered || 'nobody yet'}`);
            return;
          }
          const balance = await ctx.points.getBalance(e.user.id, e.channel);
          await ctx.chat.say(e.channel, `@${e.user.displayName} you have ${balance} ${CURRENCY}.`);
        },
        { aliases: ['p'], description: `Check your ${CURRENCY} (or "!points top").`, usage: '[top]', cooldownSeconds: 3 },
      );

      ctx.commands.register(
        'give',
        async (e) => {
          const [target, amountRaw] = e.args;
          const amount = Number(amountRaw);
          if (!target || !Number.isInteger(amount) || amount <= 0) {
            await ctx.chat.say(e.channel, `Usage: !give <user> <amount>`);
            return;
          }
          const recipient = await ctx.users.getByLogin(target.replace(/^@/, ''));
          if (!recipient) {
            await ctx.chat.say(e.channel, `I don't know a user called ${target} yet.`);
            return;
          }
          try {
            await ctx.points.transfer(e.user.id, recipient.id, e.channel, amount);
            await ctx.chat.say(e.channel, `@${e.user.displayName} gave ${amount} ${CURRENCY} to ${recipient.displayName}.`);
          } catch (err) {
            if (err instanceof InsufficientPointsError) {
              await ctx.chat.say(e.channel, `@${e.user.displayName} you only have ${err.balance} ${CURRENCY}.`);
            } else {
              throw err;
            }
          }
        },
        { permission: PermissionLevel.Subscriber, description: `(Sub+) Give ${CURRENCY} to another user.`, usage: '<user> <amount>', cooldownSeconds: 3 },
      );

      ctx.commands.register(
        'addpoints',
        async (e) => {
          const [target, amountRaw] = e.args;
          const amount = Number(amountRaw);
          if (!target || !Number.isInteger(amount)) {
            await ctx.chat.say(e.channel, `Usage: !addpoints <user> <amount>`);
            return;
          }
          const recipient = await ctx.users.getByLogin(target.replace(/^@/, ''));
          if (!recipient) {
            await ctx.chat.say(e.channel, `Unknown user ${target}.`);
            return;
          }
          const balance = await ctx.points.award(recipient.id, e.channel, amount);
          await ctx.chat.say(e.channel, `${recipient.displayName} now has ${balance} ${CURRENCY}.`);
        },
        { permission: PermissionLevel.Broadcaster, description: `(Broadcaster) Grant/deduct ${CURRENCY}.`, usage: '<user> <amount>' },
      );
    },

    start() {
      timer = setInterval(() => void payout(), PAYOUT_INTERVAL_MS);
    },

    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
}
