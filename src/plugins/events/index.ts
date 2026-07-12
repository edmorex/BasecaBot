import type { Plugin } from '../types.js';
import type { ServiceContext } from '../../core/serviceContext.js';

/**
 * Reacts to stream events with chat shout-outs and writes an audit trail to the
 * EventLog table. Point payouts for subs/bits live in the points plugin; this
 * plugin owns the *announcements* and *logging*, keeping concerns separated.
 *
 * The `donation` handler is wired here already even though no provider emits it
 * yet — when a StreamElements/StreamLabs adapter is added it just publishes
 * `donation` events and this reacts automatically.
 */
export function eventsPlugin(): Plugin {
  return {
    name: 'events',
    version: '0.1.0',

    init(ctx: ServiceContext) {
      const log = (type: string, userId: string | null, amount: number | null, meta?: unknown) =>
        ctx.storage.prisma.eventLog
          .create({ data: { type, userId, amount, meta: meta ? JSON.stringify(meta) : null } })
          .catch((err) => ctx.logger.error({ err }, 'eventLog write failed'));

      ctx.bus.on('sub', async (e) => {
        await ctx.chat.say(e.channel, `🎉 Thanks for subscribing, @${e.user.displayName}!`);
        await log('sub', e.user.id, null, { tier: e.tier });
      });

      ctx.bus.on('resub', async (e) => {
        await ctx.chat.say(e.channel, `🎉 @${e.user.displayName} resubbed for ${e.months} months!`);
        await log('resub', e.user.id, e.months, { tier: e.tier });
      });

      ctx.bus.on('subgift', async (e) => {
        await ctx.chat.say(e.channel, `🎁 ${e.gifter.displayName} gifted ${e.count} sub(s)!`);
        await log('subgift', e.gifter.id || null, e.count);
      });

      ctx.bus.on('bits', async (e) => {
        await ctx.chat.say(e.channel, `✨ ${e.user.displayName} cheered ${e.amount} bits!`);
        await log('bits', e.user.id || null, e.amount);
      });

      ctx.bus.on('raid', async (e) => {
        await ctx.chat.say(e.channel, `🚀 ${e.fromLogin} raided with ${e.viewers} viewers! Welcome!`);
        await log('raid', null, e.viewers, { from: e.fromLogin });
      });

      ctx.bus.on('follow', async (e) => {
        await ctx.chat.say(e.channel, `👋 Thanks for the follow, @${e.user.displayName}!`);
        await log('follow', e.user.id, null);
      });

      ctx.bus.on('donation', async (e) => {
        await ctx.chat.say(e.channel, `💜 ${e.fromName} donated ${e.amount} ${e.currency}! Thank you!`);
        await log('donation', null, Math.round(e.amount), { currency: e.currency });
      });
    },
  };
}
