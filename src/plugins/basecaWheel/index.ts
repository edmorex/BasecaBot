import type { Plugin } from '../types.js';
import type { ServiceContext } from '../../core/serviceContext.js';

/** WebSocket room name the BasecaWheel web app connects to. */
const ROOM = 'baseca-wheel';

/** Subcommands the wheel understands. */
const SUBCOMMANDS = new Set(['title', 'add', 'spin', 'clear', 'reset']);

/** Subcommands that carry no text (action only). */
const NO_TEXT_SUBCOMMANDS = new Set(['spin', 'clear', 'reset']);

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
      ctx.commands.register(
        'wheel',
        async (e) => {
          const sub = e.args[0]?.toLowerCase();
          if (!sub || !SUBCOMMANDS.has(sub)) {
            await ctx.chat.say(
              e.channel,
              'Usage: !wheel title <text> | !wheel add <entry> | !wheel spin | !wheel clear | !wheel reset',
            );
            return;
          }

          // Everything after the subcommand is the payload text (empty for action-only subcommands).
          const text = NO_TEXT_SUBCOMMANDS.has(sub) ? '' : e.argString.slice(e.args[0]!.length).trim();
          if (!NO_TEXT_SUBCOMMANDS.has(sub) && !text) {
            await ctx.chat.say(e.channel, `Usage: !wheel ${sub} <text>`);
            return;
          }

          const payload: WheelCommandPayload = {
            command: sub,
            text,
            user: e.user.displayName,
            permission: e.user.permission,
          };
          ctx.ws.broadcast(ROOM, 'wheel', payload);
          ctx.logger.debug({ payload }, 'forwarded wheel command');
        },
        {
          description: 'Control the BasecaWheel: !wheel title|add|spin|clear|reset',
          // Light throttle to avoid flooding the hub; the web app enforces real
          // per-user submission limits.
          cooldownSeconds: 1,
        },
      );

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
