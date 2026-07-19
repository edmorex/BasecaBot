import type { Plugin } from '../types.js';
import type { ServiceContext } from '../../core/serviceContext.js';
import { InsufficientPointsError } from '../../services/points.js';
import { PermissionLevel, type CommandEvent } from '../../core/events.js';

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
 * events.
 *
 * Commands follow the `!<command> <subcommand>` shape used by the other
 * plugins: `!points` (balance), `!points give` (sub+), `!points grant`
 * (broadcaster). There is deliberately no leaderboard — balances are private to
 * the user who asks.
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
        if (higher) await ctx.points.award(ch.userId, SUB_POINTS);
        else await ctx.points.awardCapped(ch.userId, NONSUB_POINTS, NONSUB_CAP);
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
      const CURRENCY = ctx.config.points.name;

      // ── Commands ──────────────────────────────────────────────────────────

      /** Resolve a `<user> <amount>` argument pair, or explain what's wrong. */
      const parseTarget = async (
        e: CommandEvent,
        label: string,
        allowNegative: boolean,
      ): Promise<{ id: string; displayName: string; amount: number } | null> => {
        const [target, amountRaw] = e.args;
        const amount = Number(amountRaw);
        const validAmount = Number.isInteger(amount) && (allowNegative ? amount !== 0 : amount > 0);
        if (!target || !validAmount) {
          await ctx.chat.say(e.channel, `Usage: !points ${label} <user> <amount>`);
          return null;
        }
        // Any of the user's names works here — @handle, display name, or alias.
        const recipient = await ctx.users.resolveUserRef(target);
        if (recipient.kind !== 'user') {
          await ctx.chat.say(e.channel, `I don't know a user called ${target}.`);
          return null;
        }
        return { id: recipient.id, displayName: recipient.displayName, amount };
      };

      ctx.commands.registerGroup('points', {
        description: `Check your ${CURRENCY}. Subs can "give" to someone else; the broadcaster can "grant".`,
        permission: PermissionLevel.Viewer,
        aliases: ['p'],
        // Bare `!points` — and anything unrecognized — just reports the balance.
        onUnknown: async (e) => {
          const balance = await ctx.points.getBalance(e.user.id);
          await ctx.chat.say(e.channel, `@${e.user.displayName} you have ${balance} ${CURRENCY}.`);
        },
        subcommands: {
          give: {
            description: `(Sub+) Transfer your own ${CURRENCY} to another user.`,
            usage: '<user> <amount>',
            permission: PermissionLevel.Subscriber,
            cooldownSeconds: 3,
            handler: async (e) => {
              const t = await parseTarget(e, 'give', false);
              if (!t) return;
              try {
                await ctx.points.transfer(e.user.id, t.id, t.amount);
                await ctx.chat.say(e.channel, `@${e.user.displayName} gave ${t.amount} ${CURRENCY} to ${t.displayName}.`);
              } catch (err) {
                if (err instanceof InsufficientPointsError) {
                  await ctx.chat.say(e.channel, `@${e.user.displayName} you only have ${err.balance} ${CURRENCY}.`);
                } else {
                  throw err;
                }
              }
            },
          },
          grant: {
            description: `(Broadcaster) Create or deduct ${CURRENCY} for a user; a negative amount removes.`,
            usage: '<user> <amount>',
            permission: PermissionLevel.Broadcaster,
            handler: async (e) => {
              const t = await parseTarget(e, 'grant', true);
              if (!t) return;
              const balance = await ctx.points.award(t.id, t.amount);
              await ctx.chat.say(e.channel, `${t.displayName} now has ${balance} ${CURRENCY}.`);
            },
          },
        },
      });
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
