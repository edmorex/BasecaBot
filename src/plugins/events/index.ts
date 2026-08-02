import type { Plugin } from '../types.js';
import type { ServiceContext } from '../../core/serviceContext.js';
import type { EventUser } from '../../core/events.js';

/**
 * Reacts to stream events with chat shout-outs and writes an audit trail to the
 * EventLog table. Point payouts for subs/bits live in the points plugin; this
 * plugin owns the *announcements* and *logging*, keeping concerns separated.
 *
 * The announcement strings are registered with the TextStrings service, so the
 * broadcaster can edit them on the dashboard (Admin → Text Strings) without a
 * redeploy. Each uses `{token}` placeholders substituted at send time.
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
      // Register the editable announcement strings (feature "events").
      const strings: Array<{ key: string; label: string; default: string; placeholders: string[] }> = [
        { key: 'live', label: 'Stream live', default: '😻 The stream has gone live! Who will be !first?', placeholders: [] },
        { key: 'sub', label: 'Subscription', default: '🎉 Thanks for subscribing, @{user}!', placeholders: ['user', 'tier'] },
        { key: 'resub', label: 'Resub', default: '🎉 @{user} resubbed for {months} months!', placeholders: ['user', 'months', 'tier'] },
        { key: 'subgift', label: 'Gifted sub(s)', default: '🎁 {gifter} gifted {count} sub(s)!', placeholders: ['gifter', 'count'] },
        { key: 'bits', label: 'Bits / cheer', default: '✨ {user} cheered {amount} bits!', placeholders: ['user', 'amount'] },
        { key: 'raid', label: 'Raid', default: '🚀 {from} raided with {viewers} viewers! Welcome!', placeholders: ['from', 'viewers'] },
        { key: 'follow', label: 'Follow', default: '👋 Thanks for the follow, @{user}!', placeholders: ['user'] },
        { key: 'donation', label: 'Donation', default: '💜 {name} donated {amount} {currency}! Thank you!', placeholders: ['name', 'amount', 'currency'] },
      ];
      for (const s of strings) ctx.text.register({ feature: 'events', ...s });
      const say = (channel: string, key: string, vars: Record<string, string | number>) =>
        ctx.chat.say(channel, ctx.text.format('events', key, vars));

      const log = (type: string, userId: string | null, amount: number | null, meta?: unknown) =>
        ctx.storage.prisma.eventLog
          .create({ data: { type, userId, amount, meta: meta ? JSON.stringify(meta) : null } })
          .catch((err) => ctx.logger.error({ err }, 'eventLog write failed'));

      /**
       * Log an event attributed to a user. `EventLog.userId` is a foreign key, and
       * these events routinely come from people who have never chatted (follows,
       * lurker subs/bits), so the user must be persisted first. If that fails we
       * still record the event with a null user rather than losing the row.
       */
      const logFor = async (type: string, u: EventUser | null, amount: number | null, meta?: unknown) => {
        let userId: string | null = null;
        if (u?.id) {
          try {
            await ctx.users.touch(u);
            userId = u.id;
          } catch (err) {
            ctx.logger.error({ err, login: u.login }, 'users.touch failed before eventLog write');
          }
        }
        await log(type, userId, amount, meta);
      };

      ctx.bus.on('live', async (e) => {
        await say(e.channel, 'live', {});
        await log('live', null, null);
      });

      ctx.bus.on('sub', async (e) => {
        await say(e.channel, 'sub', { user: e.user.displayName, tier: e.tier });
        await logFor('sub', e.user, null, { tier: e.tier });
      });

      ctx.bus.on('resub', async (e) => {
        await say(e.channel, 'resub', { user: e.user.displayName, months: e.months, tier: e.tier });
        await logFor('resub', e.user, e.months, { tier: e.tier });
      });

      ctx.bus.on('subgift', async (e) => {
        await say(e.channel, 'subgift', { gifter: e.gifter.displayName, count: e.count });
        await logFor('subgift', e.gifter, e.count); // gifter.id is '' when anonymous
      });

      ctx.bus.on('bits', async (e) => {
        await say(e.channel, 'bits', { user: e.user.displayName, amount: e.amount });
        await logFor('bits', e.user, e.amount); // user.id is '' for anonymous cheers
      });

      ctx.bus.on('raid', async (e) => {
        await say(e.channel, 'raid', { from: e.fromLogin, viewers: e.viewers });
        await log('raid', null, e.viewers, { from: e.fromLogin });
      });

      ctx.bus.on('follow', async (e) => {
        await say(e.channel, 'follow', { user: e.user.displayName });
        await logFor('follow', e.user, null);
      });

      ctx.bus.on('donation', async (e) => {
        await say(e.channel, 'donation', { name: e.fromName, amount: e.amount, currency: e.currency });
        await log('donation', null, Math.round(e.amount), { currency: e.currency });
      });
    },
  };
}
