import type { Plugin } from '../types.js';
import type { ServiceContext } from '../../core/serviceContext.js';

/** WebSocket room name the BasecaWheel web app connects to. */
const ROOM = 'baseca-wheel';

/**
 * The command sent to the BasecaWheel web app over the WebSocket hub. Emitted as
 * a single message type ('wheel'); the specific action is in `command`.
 *
 * The bot does NOT enforce per-user submission limits or action permissions —
 * it forwards the caller's permission level and the web app decides whether to
 * accept (per the BasecaWheel integration spec).
 */
interface WheelCommandPayload {
  /** 'title' | 'add' | 'spin' | 'clear' | 'reset' */
  command: string;
  /** The title text (title), entry text (add), or '' (spin/clear/reset). */
  text: string;
  /** Display name of the user who sent the command. */
  user: string;
  /** PermissionLevel integer (see core/events.ts): 0 Viewer .. 5 Admin. */
  permission: number;
}

/**
 * BasecaWheel — bridges chat `!wheel` commands to the BasecaWheel web app.
 *
 *   !wheel title <text>   -> forward { command: 'title', text }
 *   !wheel add <text>     -> forward { command: 'add',   text }
 *   !wheel spin           -> forward { command: 'spin',  text: '' }
 *   !wheel clear          -> forward { command: 'clear', text: '' }  (clear own entries)
 *   !wheel reset          -> forward { command: 'reset', text: '' }  (wipe whole wheel)
 *
 * The web app connects to the hub at:
 *   ws://<host>:<WS_HUB_PORT>?room=baseca-wheel&secret=<WS_HUB_SECRET>
 *
 * It may optionally message back (same room) to speak in chat:
 *   { type: 'announce', payload: { text } }            -> bot says text
 *   { type: 'result',   payload: { winner } }          -> bot announces winner
 */
export function basecaWheelPlugin(): Plugin {
  return {
    name: 'basecaWheel',
    version: '0.1.0',

    init(ctx: ServiceContext) {
      // Forward a subcommand to the web app. The web app enforces real per-user
      // submission limits / action permissions; the bot just relays with the
      // caller's identity + permission level.
      const forward = (e: { channel: string; argString: string; user: { displayName: string; permission: number } }, command: string, text: string) => {
        const payload: WheelCommandPayload = { command, text, user: e.user.displayName, permission: e.user.permission };
        ctx.ws.broadcast(ROOM, 'wheel', payload);
        ctx.logger.debug({ payload }, 'forwarded wheel command');
      };
      // A subcommand that needs text: require it, else print usage.
      const withText = (command: string) => async (e: { channel: string; argString: string; user: { displayName: string; permission: number } }) => {
        const text = e.argString.trim();
        if (!text) return void ctx.chat.say(e.channel, `Usage: !wheel ${command} [text]`);
        forward(e, command, text);
      };
      const action = (command: string) => async (e: { channel: string; argString: string; user: { displayName: string; permission: number } }) =>
        forward(e, command, '');

      ctx.commands.registerGroup('wheel', {
        description: 'BasecaWheel — subcommands: title, add, spin, clear, reset.',
        subcommands: {
          title: { description: 'Set the title of the wheel.', usage: '<text>', handler: withText('title') },
          add: { description: 'Add an entrant to the wheel.', usage: '<text>', cooldownSeconds: 1, handler: withText('add') },
          spin: { description: 'Spin the wheel.', globalCooldownSeconds: 2, handler: action('spin') },
          clear: { description: "Clear your own entrant(s) from the wheel.", cooldownSeconds: 1, handler: action('clear') },
          reset: { description: 'Reset the wheel to no entrants.', handler: action('reset') },
        },
      });

      // Optional messages coming back FROM the wheel web app.
      ctx.bus.on('wsMessage', async (e) => {
        if (e.room !== ROOM) return;
        const payload = (e.payload ?? {}) as { text?: string; winner?: string };
        switch (e.messageType) {
          case 'announce':
            if (payload.text) await ctx.chat.say(e.channel, payload.text);
            break;
          case 'result':
            await ctx.chat.say(e.channel, `🎡 The wheel landed on ${payload.winner ?? 'nobody'}!`);
            break;
          default:
            ctx.logger.debug({ messageType: e.messageType }, 'unhandled wheel ws message');
        }
      });
    },
  };
}
