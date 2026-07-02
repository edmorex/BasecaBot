import type { Plugin } from '../types.js';
import type { ServiceContext } from '../../core/serviceContext.js';
import { PermissionLevel, type BotEvent, type EventUser } from '../../core/events.js';

/** WebSocket room the event-simulator harness connects to. */
const ROOM = 'event-sim';

/**
 * DEV-ONLY bridge that turns messages from the `event-sim` WebSocket room into
 * real BotEvents on the bus, so the events/points plugins can be exercised
 * without live Twitch traffic. Enabled only when `EVENT_SIM_ENABLED=true`.
 *
 * The harness sends `{ type: '<eventType>', room: 'event-sim', payload: {...} }`
 * where `<eventType>` is one of: sub, resub, subgift, bits, raid, follow,
 * donation. This plugin normalizes the payload into the matching BotEvent and,
 * for events that carry a user, ensures that user row exists first (so points
 * awards and EventLog foreign keys don't fail).
 *
 * NOTE: reactions are real — the bot posts to your actual chat and mutates the
 * DB (points, EventLog). Point it at your own test channel.
 */
export function eventSimulatorPlugin(): Plugin {
  return {
    name: 'eventSimulator',
    version: '0.1.0',

    init(ctx: ServiceContext) {
      if (!ctx.config.eventSim.enabled) {
        ctx.logger.info('eventSimulator disabled (set EVENT_SIM_ENABLED=true to enable)');
        return;
      }
      ctx.logger.warn('eventSimulator ENABLED — fake events can be injected via the event-sim room');

      /** Build a synthetic EventUser from a display name (stable id per login). */
      const makeUser = (
        displayName: string | undefined,
        permission = PermissionLevel.Viewer,
      ): EventUser => {
        const name = (displayName ?? 'TestUser').trim() || 'TestUser';
        const login = name.toLowerCase().replace(/[^a-z0-9_]/g, '_');
        return { id: `sim-${login}`, login, displayName: name, permission };
      };

      ctx.bus.on('wsMessage', async (e) => {
        if (e.room !== ROOM) return;
        const p = (e.payload ?? {}) as Record<string, unknown>;
        const channel = (typeof p.channel === 'string' && p.channel) || e.channel;
        const ts = Date.now();
        const str = (v: unknown, d = '') => (typeof v === 'string' ? v : d);
        const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || d);

        let event: BotEvent | undefined;

        switch (e.messageType) {
          case 'sub': {
            const user = makeUser(str(p.user, 'TestUser'), PermissionLevel.Subscriber);
            await ctx.users.touch(user);
            event = { type: 'sub', channel, ts, user, tier: str(p.tier, '1000'), months: num(p.months, 1), message: str(p.message) || undefined };
            break;
          }
          case 'resub': {
            const user = makeUser(str(p.user, 'TestUser'), PermissionLevel.Subscriber);
            await ctx.users.touch(user);
            event = { type: 'resub', channel, ts, user, tier: str(p.tier, '1000'), months: num(p.months, 1), message: str(p.message) || undefined };
            break;
          }
          case 'subgift': {
            const gifter = makeUser(str(p.gifter, 'TestGifter'));
            await ctx.users.touch(gifter);
            event = { type: 'subgift', channel, ts, gifter, recipientLogin: str(p.recipientLogin), tier: str(p.tier, '1000'), count: num(p.count, 1) };
            break;
          }
          case 'bits': {
            const user = makeUser(str(p.user, 'TestUser'));
            await ctx.users.touch(user);
            event = { type: 'bits', channel, ts, user, amount: num(p.amount, 100), message: str(p.message) || undefined };
            break;
          }
          case 'raid':
            event = { type: 'raid', channel, ts, fromLogin: str(p.fromLogin, 'someraider'), viewers: num(p.viewers, 10) };
            break;
          case 'follow': {
            const user = makeUser(str(p.user, 'TestUser'));
            await ctx.users.touch(user);
            event = { type: 'follow', channel, ts, user };
            break;
          }
          case 'donation':
            event = { type: 'donation', channel, ts, fromName: str(p.fromName, 'TestDonor'), amount: num(p.amount, 5), currency: str(p.currency, 'USD'), message: str(p.message) || undefined };
            break;
          default:
            ctx.logger.debug({ messageType: e.messageType }, 'eventSimulator: unknown event type');
            return;
        }

        ctx.logger.info({ type: event.type }, 'eventSimulator: injecting event');
        await ctx.bus.publish(event);
        // Acknowledge back to the harness so it can show a confirmation.
        ctx.ws.broadcast(ROOM, 'ack', { injected: event.type });
      });
    },
  };
}
