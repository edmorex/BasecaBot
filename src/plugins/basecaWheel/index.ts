import type { Plugin } from '../types.js';
import type { ServiceContext } from '../../core/serviceContext.js';
import type { CommandEvent } from '../../core/events.js';
import { PermissionLevel } from '../../core/events.js';

/** WebSocket room name the BasecaWheel web app connects to. */
const ROOM = 'baseca-wheel';

/** Guest-connection defaults/bounds (seconds). */
const DEFAULT_TIMEOUT = 21600; // 6 hours
const MIN_TIMEOUT = 30;
const MAX_TIMEOUT = 86400; // 24 hours

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

/** Normalize a channel argument (`#Foo` / `@foo` -> `foo`); '' if implausible. */
function normalizeChannel(raw: string): string {
  const name = raw.trim().toLowerCase().replace(/^[#@]/, '');
  return /^[a-z0-9_]{1,25}$/.test(name) ? name : '';
}

/** Split the leading token (channel / seconds) from the rest. */
function firstAndRest(input: string): { first: string; rest: string } {
  const s = input.trim();
  const i = s.indexOf(' ');
  if (i === -1) return { first: s, rest: '' };
  return { first: s.slice(0, i), rest: s.slice(i + 1).trim() };
}

/** Human-friendly duration for announcements. */
function formatDuration(seconds: number): string {
  if (seconds % 3600 === 0) return `${seconds / 3600} hour${seconds === 3600 ? '' : 's'}`;
  if (seconds % 60 === 0) return `${seconds / 60} minute${seconds === 60 ? '' : 's'}`;
  return `${seconds} seconds`;
}

/**
 * BasecaWheel — bridges chat `!wheel` commands to the BasecaWheel web app.
 *
 *   !wheel title <text>      -> forward { command: 'title', text }
 *   !wheel add <text>        -> forward { command: 'add',   text }
 *   !wheel spin              -> forward { command: 'spin',  text: '' }
 *   !wheel clear             -> forward { command: 'clear', text: '' }  (clear own entries)
 *   !wheel clearall          -> forward { command: 'clearall', text: '' }  (wipe whole wheel)
 *   !wheel connect <ch> [s]  -> temporarily join guest channel <ch> (Broadcaster+, primary only)
 *   !wheel disconnect        -> leave the current guest channel (Broadcaster+, primary only)
 *
 * Every forwarded payload carries the originating `channel`; the web app echoes
 * it back on `announce`/`result` so the bot speaks in the right chat (primary or
 * guest). The web app connects to the hub at:
 *   ws://<host>:<WS_HUB_PORT>?room=baseca-wheel&secret=<WS_HUB_SECRET>
 *
 * It may optionally message back (same room) to speak in chat:
 *   { type: 'announce', payload: { text, channel } }   -> bot says text in `channel`
 *   { type: 'result',   payload: { winner, channel } } -> bot announces winner in `channel`
 */
export function basecaWheelPlugin(): Plugin {
  let ctx: ServiceContext;
  // At most one guest channel at a time (single shared wheel surface).
  let guest: { channel: string; timer: ReturnType<typeof setTimeout> } | null = null;

  /** Leave the current guest channel (announcing first, unless shutting down). */
  async function partGuest(announce: boolean): Promise<void> {
    if (!guest) return;
    const channel = guest.channel;
    clearTimeout(guest.timer);
    guest = null;
    if (announce) {
      await ctx.chat
        .say(channel, '👋 BasecaBot is heading out — thanks for having me! The host can bring me back with !wheel connect.')
        .catch(() => {});
    }
    ctx.chat.part(channel);
    ctx.logger.info({ channel }, 'wheel: left guest channel');
  }

  return {
    name: 'basecaWheel',
    version: '0.2.0',

    init(context: ServiceContext) {
      ctx = context;
      const primary = ctx.config.twitch.channel;

      // Forward a subcommand to the web app, tagged with the originating channel.
      const forward = (e: WheelEvent, command: string, text: string) => {
        const payload: WheelCommandPayload = { command, text, user: e.user.displayName, permission: e.user.permission, channel: e.channel };
        ctx.ws.broadcast(ROOM, 'wheel', payload);
        ctx.logger.debug({ payload }, 'forwarded wheel command');
      };
      const withText = (command: string) => async (e: WheelEvent) => {
        const text = e.argString.trim();
        if (!text) return void ctx.chat.say(e.channel, `Usage: !wheel ${command} [text]`);
        forward(e, command, text);
      };
      const action = (command: string) => async (e: WheelEvent) => forward(e, command, '');

      ctx.commands.registerGroup('wheel', {
        description:
          'BasecaWheel Usage: !wheel <command> [text] — commands: add <text>, clear, spin, title <text>, clearall. Broadcaster: connect <channel> [seconds], disconnect.',
        subcommands: {
          title: { description: 'Set the title of the wheel.', usage: '<text>', globalCooldownSeconds: 2, handler: withText('title') },
          add: { description: 'Add an entrant to the wheel.', usage: '<text>', cooldownSeconds: 1, handler: withText('add') },
          spin: { description: 'Spin the wheel.', globalCooldownSeconds: 1, cooldownSeconds: 5, handler: action('spin') },
          clear: { description: "Clear your own entrant(s) from the wheel.", cooldownSeconds: 2, handler: action('clear') },
          clearall: { description: 'Clear the wheel of all entrants.', cooldownSeconds: 5, handler: action('clearall') },
          connect: {
            description: 'Temporarily join a guest channel so it can use the wheel (Broadcaster+).',
            usage: '<guestChannel> [seconds]',
            permission: PermissionLevel.Broadcaster,
            handler: async (e: CommandEvent) => {
              if (e.channel !== primary) return; // only invitable from the primary channel
              const { first, rest } = firstAndRest(e.argString);
              const target = normalizeChannel(first);
              if (!target) return void ctx.chat.say(e.channel, 'Usage: !wheel connect <guestChannel> [seconds]');
              if (target === primary) return void ctx.chat.say(e.channel, "I'm already in this channel.");

              const parsed = Number.parseInt(rest, 10);
              const seconds = Number.isFinite(parsed) && parsed > 0 ? Math.min(MAX_TIMEOUT, Math.max(MIN_TIMEOUT, parsed)) : DEFAULT_TIMEOUT;

              if (guest) await partGuest(true); // one guest at a time
              try {
                await ctx.chat.join(target);
              } catch (err) {
                ctx.logger.error({ err, target }, 'wheel: failed to join guest channel');
                return void ctx.chat.say(e.channel, `Couldn't join ${target}. Is that a valid channel name?`);
              }
              guest = { channel: target, timer: setTimeout(() => void partGuest(true), seconds * 1000) };
              await ctx.chat.say(
                target,
                `👋 BasecaBot is here for BasecaWheel! Use !wheel add <name> to enter and !wheel spin to play. (I'll auto-leave in ${formatDuration(seconds)}.)`,
              );
              await ctx.chat.say(e.channel, `Connected to ${target} for ${formatDuration(seconds)}. Use !wheel disconnect to end early.`);
              ctx.logger.info({ target, seconds }, 'wheel: joined guest channel');
            },
          },
          disconnect: {
            description: 'Leave the current guest channel (Broadcaster+).',
            permission: PermissionLevel.Broadcaster,
            handler: async (e: CommandEvent) => {
              if (e.channel !== primary) return;
              if (!guest) return void ctx.chat.say(e.channel, "I'm not connected to any guest channel.");
              const left = guest.channel;
              await partGuest(true);
              await ctx.chat.say(e.channel, `Disconnected from ${left}.`);
            },
          },
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
            await ctx.chat.say(channel, `BasecaWheel has decided! The winner is ${payload.winner ?? 'nobody'}!`);
            break;
          default:
            ctx.logger.debug({ messageType: e.messageType }, 'unhandled wheel ws message');
        }
      });
    },

    // Leave any guest channel cleanly on shutdown (no announcement).
    stop() {
      void partGuest(false);
    },
  };
}
