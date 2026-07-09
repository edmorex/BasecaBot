import type { Plugin } from '../types.js';
import type { ServiceContext } from '../../core/serviceContext.js';
import { PermissionLevel } from '../../core/events.js';

const ROOM = 'sample-game';
const WINNER_REWARD = 100;

/**
 * Reference game plugin demonstrating the end-to-end integration loop:
 *
 *   chat  --!vote-->  bot  --ws-->  webapp (tallies & displays live)
 *   webapp  --ws('result')-->  bot  --> announces winner in chat + awards points
 *
 * The bot holds no game state itself; it forwards chat input to the web app and
 * reacts to what the web app sends back. This is the template for future games.
 */
export function sampleGamePlugin(): Plugin {
  return {
    name: 'sampleGame',
    version: '0.1.0',

    init(ctx: ServiceContext) {
      let open = false;

      ctx.commands.register(
        'startgame',
        async (e) => {
          open = true;
          ctx.ws.broadcast(ROOM, 'gameStart', { channel: e.channel });
          await ctx.chat.say(e.channel, 'A vote has started! Type !vote <option> to play.');
        },
        { permission: PermissionLevel.Moderator, description: '(Mod) Start the sample voting game.' },
      );

      ctx.commands.register(
        'endgame',
        async (e) => {
          open = false;
          ctx.ws.broadcast(ROOM, 'gameEnd', {});
          await ctx.chat.say(e.channel, 'Voting closed.');
        },
        { permission: PermissionLevel.Moderator, description: '(Mod) End the sample voting game.' },
      );

      ctx.commands.register(
        'vote',
        async (e) => {
          if (!open) return;
          const option = e.args[0];
          if (!option) return;
          // Forward the chat-derived input to the web app in real time.
          ctx.ws.broadcast(ROOM, 'vote', {
            userId: e.user.id,
            user: e.user.displayName,
            option,
          });
        },
        { description: 'Cast a vote in the current game.', usage: '<option>', cooldownSeconds: 1 },
      );

      // Handle messages coming back FROM the web app.
      ctx.bus.on('wsMessage', async (e) => {
        if (e.room !== ROOM) return;
        const payload = (e.payload ?? {}) as { text?: string; winnerUserId?: string; winner?: string };

        switch (e.messageType) {
          case 'announce':
            if (payload.text) await ctx.chat.say(e.channel, payload.text);
            break;
          case 'result': {
            open = false;
            const label = payload.winner ?? 'nobody';
            await ctx.chat.say(e.channel, `The winner is ${label}!`);
            if (payload.winnerUserId) {
              await ctx.points.award(payload.winnerUserId, e.channel, WINNER_REWARD);
              await ctx.chat.say(e.channel, `${label} earned ${WINNER_REWARD} points!`);
            }
            break;
          }
          default:
            ctx.logger.debug({ messageType: e.messageType }, 'unhandled ws message');
        }
      });
    },
  };
}
