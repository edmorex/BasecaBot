import type { Plugin } from '../types.js';
import type { ServiceContext } from '../../core/serviceContext.js';
import { InsufficientPointsError } from '../../services/points.js';
import { PermissionLevel } from '../../core/events.js';

const CURRENCY = 'points';
const CHAT_AWARD = 1; // points per chat message (simple activity accrual)
const SUB_BONUS = 500;
const BITS_PER_POINT = 1; // 1 point per bit cheered

/**
 * The loyalty economy plugin: viewer-facing commands plus passive/earned
 * point accrual driven by chat activity and stream events.
 */
export function pointsPlugin(): Plugin {
  return {
    name: 'points',
    version: '0.1.0',

    init(ctx: ServiceContext) {
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
        { description: `Give ${CURRENCY} to another user.`, usage: '<user> <amount>', cooldownSeconds: 3 },
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
        { permission: PermissionLevel.Moderator, description: `(Mod) Grant/deduct ${CURRENCY}.`, usage: '<user> <amount>' },
      );

      // ── Passive & earned accrual ──────────────────────────────────────────
      ctx.bus.on('chat', async (e) => {
        // User is guaranteed to exist because chatAdapter.touch runs first,
        // but award() upserts the balance regardless.
        await ctx.points.award(e.user.id, e.channel, CHAT_AWARD);
      });

      ctx.bus.on('sub', async (e) => {
        await ctx.points.award(e.user.id, e.channel, SUB_BONUS);
      });
      ctx.bus.on('resub', async (e) => {
        await ctx.points.award(e.user.id, e.channel, SUB_BONUS);
      });
      ctx.bus.on('bits', async (e) => {
        if (!e.user.id) return;
        await ctx.points.award(e.user.id, e.channel, e.amount * BITS_PER_POINT);
      });
    },
  };
}
