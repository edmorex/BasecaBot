import type { Plugin } from '../types.js';
import type { ServiceContext } from '../../core/serviceContext.js';
import type { CommandEvent } from '../../core/events.js';
import { PermissionLevel } from '../../core/events.js';
import { firstAndRest } from '../../services/strings.js';
import { normalizeChannel, clampTimeout, formatDuration } from '../../services/guestChannels.js';

/**
 * Generic guest-channel control:
 *   !connect <channel> [seconds]  -> bring the bot into another channel temporarily
 *   !disconnect                   -> pull it back out
 *
 * While in a guest channel only WHITELISTED features act — each feature registers
 * itself with `ctx.guests.registerFeature(...)`; every other command and all
 * custom-command/phrase matching is suppressed (enforced by the command router +
 * chat adapter). The mechanics (join/part, auto-leave timer, greeting/farewell)
 * live in GuestChannelService; this plugin is just the command surface.
 */
export function guestsPlugin(): Plugin {
  return {
    name: 'guests',
    version: '0.1.0',

    init(ctx: ServiceContext) {
      const primary = ctx.config.twitch.channel;

      const strings: Array<{ key: string; label: string; default: string; placeholders: string[] }> = [
        { key: 'connected', label: 'Connect confirmation (primary)', default: 'Connected to {channel} for {duration}. Use !disconnect to end early.', placeholders: ['channel', 'duration'] },
        { key: 'disconnected', label: 'Disconnect confirmation', default: 'Disconnected from {channel}.', placeholders: ['channel'] },
        { key: 'alreadyHere', label: 'Connect — already there', default: "I'm already in this channel.", placeholders: [] },
        { key: 'joinFailed', label: 'Connect — join failed', default: "Couldn't join {channel}. Is that a valid channel name?", placeholders: ['channel'] },
        { key: 'notConnected', label: 'Disconnect — not connected', default: "I'm not connected to any guest channel.", placeholders: [] },
        { key: 'usageConnect', label: 'Usage — connect', default: 'Usage: !connect <channel> [seconds]', placeholders: [] },
      ];
      for (const s of strings) ctx.text.register({ feature: 'guest', ...s });
      const sayText = ctx.text.sayer(ctx.chat, 'guest'); // blank string = silent

      // `!disconnect` must be usable from INSIDE the guest channel, so register it
      // as a guest-allowed command. (`!connect` is primary-only, so it isn't.)
      ctx.guests.registerFeature({ id: 'guests', ownedCommands: ['disconnect'] });

      ctx.commands.register(
        'connect',
        async (e: CommandEvent) => {
          if (e.channel !== primary) return; // only invitable from the primary channel
          const { first, rest } = firstAndRest(e.argString);
          const target = normalizeChannel(first);
          if (!target) return void sayText(e.channel, 'usageConnect');
          if (target === primary) return void sayText(e.channel, 'alreadyHere');

          const seconds = clampTimeout(rest);
          const ok = await ctx.guests.connect(target, seconds);
          if (!ok) return void sayText(e.channel, 'joinFailed', { channel: target });
          await sayText(e.channel, 'connected', { channel: target, duration: formatDuration(seconds) });
        },
        {
          permission: PermissionLevel.Broadcaster,
          description: 'Temporarily bring the bot into a guest channel (only whitelisted features act there).',
          usage: '<channel> [seconds]',
        },
      );

      ctx.commands.register(
        'disconnect',
        async () => {
          // Runnable from the primary OR the guest channel. Confirm on the primary —
          // if run from the guest, we've just left that channel.
          const left = await ctx.guests.disconnect(true);
          if (left) await sayText(primary, 'disconnected', { channel: left });
          else await sayText(primary, 'notConnected');
        },
        {
          permission: PermissionLevel.Broadcaster,
          description: 'Pull the bot out of the current guest channel (usable from the primary or the guest).',
        },
      );
    },
  };
}
