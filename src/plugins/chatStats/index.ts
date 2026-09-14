import type { Plugin } from '../types.js';
import type { ServiceContext } from '../../core/serviceContext.js';
import { ChatStatsAggregator } from './aggregator.js';

/** WebSocket room the chat-stats overlay subscribes to. */
const ROOM = 'chat-stats';
/** How often the computed stats are pushed to the overlay. */
const TICK_MS = 1000;

/**
 * Live chat-activity statistics for an OBS overlay. Passively counts chat in the
 * FOCUS channel (the active guest channel if connected, else the primary) over a
 * few rolling windows and broadcasts them to the `chat-stats` overlay room.
 *
 * It is a guest-channel feature that `consumesRawChat`, so while connected to a
 * guest the adapter forwards all of that channel's chat here to be counted — but
 * it never acts on any of it (no commands, no chat output); the command router
 * still only lets whitelisted commands run in a guest. Purely an observer.
 */
export function chatStatsPlugin(): Plugin {
  const agg = new ChatStatsAggregator();
  let ctx: ServiceContext;
  let handle: ReturnType<typeof setInterval> | undefined;

  return {
    name: 'chatStats',
    version: '0.1.0',

    init(context: ServiceContext) {
      ctx = context;
      // Declaring consumesRawChat is what opens the guest chat firehose to us.
      ctx.guests.registerFeature({ id: 'chat-stats', consumesRawChat: true });

      ctx.bus.on('chat', (e) => {
        if (e.user.login === ctx.config.twitch.botUsername) return; // don't count the bot
        agg.add(e.channel, {
          ts: e.ts,
          userId: e.user.id,
          name: e.user.displayName,
          emotes: (e.emotes ?? []).map((em) => ({ name: em.name, count: em.count })),
        });
      });
    },

    start() {
      handle = setInterval(() => {
        const channel = ctx.guests.guestChannel() ?? ctx.config.twitch.channel;
        ctx.ws.broadcast(ROOM, 'stats', { channel, windows: agg.compute(channel) });
      }, TICK_MS);
    },

    stop() {
      if (handle) clearInterval(handle);
      handle = undefined;
    },
  };
}
