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
  /** 'title' | 'add' | 'spin' | 'clear' | 'clearall' */
  command: string;
  /** The title text (title), entry text (add), or '' (spin/clear/clearall). */
  text: string;
  /** Display name of the user who sent the command. */
  user: string;
  /** PermissionLevel integer (see core/events.ts): 0 Viewer .. 5 Admin. */
  permission: number;
  /**
   * The channel the command came from (the bot's primary channel OR a guest
   * channel). The web app MUST echo this back on its `announce`/`result`
   * responses so the bot prints to the correct chat. See
   * docs/basecawheel-integration.md.
   */
  channel: string;
}

/** A minimal command-event shape the wheel handlers need. */
type WheelEvent = { channel: string; argString: string; user: { displayName: string; permission: number } };

/**
 * BasecaWheel — bridges chat `!wheel` commands to the BasecaWheel web app.
 *
 *   !wheel title <text>      -> forward { command: 'title', text }
 *   !wheel add <text>        -> forward { command: 'add',   text }
 *   !wheel spin              -> forward { command: 'spin',  text: '' }
 *   !wheel clear             -> forward { command: 'clear', text: '' }  (clear own entries)
 *   !wheel clearall          -> forward { command: 'clearall', text: '' }  (wipe whole wheel)
 *
 * `!wheel` is whitelisted as a guest-channel feature (see ctx.guests), so it also
 * works while the bot is connected to a guest channel via `!connect`. Every
 * forwarded payload carries the originating `channel`; the web app echoes it back
 * on `announce`/`result` so the bot speaks in the right chat. The web app connects
 * to the hub at:
 *   ws://<host>:<WS_HUB_PORT>?room=baseca-wheel&secret=<WS_HUB_SECRET>
 *
 * It may optionally message back (same room) to speak in chat:
 *   { type: 'announce', payload: { text, channel } }   -> bot says text in `channel`
 *   { type: 'result',   payload: { winner, channel } } -> bot announces winner in `channel`
 */
export function basecaWheelPlugin(): Plugin {
  return {
    name: 'basecaWheel',
    version: '0.3.0',

    init(ctx: ServiceContext) {
      const strings: Array<{ key: string; label: string; default: string; placeholders: string[] }> = [
        { key: 'winner', label: 'Winner announced', default: 'BasecaWheel has decided! The winner is {winner}!', placeholders: ['winner'] },
        { key: 'usageText', label: 'Usage — add/title', default: 'Usage: !wheel {command} [text]', placeholders: ['command'] },
      ];
      for (const s of strings) ctx.text.register({ feature: 'wheel', ...s });
      const sayText = ctx.text.sayer(ctx.chat, 'wheel');

      // `!wheel` is allowed to run in guest channels (nothing else is).
      ctx.guests.registerFeature({ id: 'wheel', ownedCommands: ['wheel'] });

      // Forward a subcommand to the web app, tagged with the originating channel.
      const forward = (e: WheelEvent, command: string, text: string) => {
        const payload: WheelCommandPayload = { command, text, user: e.user.displayName, permission: e.user.permission, channel: e.channel };
        ctx.ws.broadcast(ROOM, 'wheel', payload);
        ctx.logger.debug({ payload }, 'forwarded wheel command');
      };
      const withText = (command: string) => async (e: WheelEvent) => {
        const text = e.argString.trim();
        if (!text) return void sayText(e.channel, 'usageText', { command });
        forward(e, command, text);
      };
      const action = (command: string) => async (e: WheelEvent) => forward(e, command, '');

      ctx.commands.registerGroup('wheel', {
        description:
          'BasecaWheel Usage: !wheel <command> [text] — commands: add <text>, clear, spin, title <text>, clearall.',
        subcommands: {
          title: { description: 'Set the title of the wheel.', usage: '<text>', globalCooldownSeconds: 2, handler: withText('title') },
          add: { description: 'Add an entrant to the wheel.', usage: '<text>', cooldownSeconds: 1, handler: withText('add') },
          spin: { description: 'Spin the wheel.', globalCooldownSeconds: 1, cooldownSeconds: 5, handler: action('spin') },
          clear: { description: "Clear your own entrant(s) from the wheel.", cooldownSeconds: 2, handler: action('clear') },
          clearall: { description: 'Clear the wheel of all entrants.', cooldownSeconds: 5, handler: action('clearall') },
        },
      });

      // Optional messages coming back FROM the wheel web app. The web app echoes
      // the `channel` so results land in the right chat (falls back to the hub's
      // primary channel if omitted).
      ctx.bus.on('wsMessage', async (e) => {
        if (e.room !== ROOM) return;
        const payload = (e.payload ?? {}) as { text?: string; winner?: string; channel?: string };
        const channel = typeof payload.channel === 'string' && payload.channel.trim() ? payload.channel.trim().toLowerCase() : e.channel;
        switch (e.messageType) {
          case 'announce':
            if (payload.text) await ctx.chat.say(channel, payload.text);
            break;
          case 'result':
            await sayText(channel, 'winner', { winner: payload.winner ?? 'nobody' });
            break;
          default:
            ctx.logger.debug({ messageType: e.messageType }, 'unhandled wheel ws message');
        }
      });
    },
  };
}
