import type { Plugin } from '../types.js';
import type { ServiceContext } from '../../core/serviceContext.js';
import type { CommandEvent } from '../../core/events.js';
import { PermissionLevel } from '../../core/events.js';
import { TimerError } from '../../services/timers.js';

/**
 * Timers: mod-managed named timers that fire a bound command/alias either once
 * after a delay (`!timer start`) or repeatedly every period (`!timer loop`).
 *
 * The scoring/scheduling lives in TimerService; this plugin (a) registers the
 * `!timer …` command group, (b) teaches the service HOW to fire a bound command
 * (run it as the broadcaster through the router, so both built-ins and custom
 * triggers/aliases work with full variable rendering) and how to tell if the
 * channel is live (loop mode skips fires while offline), and (c) resumes any
 * armed loops on startup.
 */
export function timersPlugin(): Plugin {
  let stopRuntime: () => void = () => {};
  let resume: () => Promise<void> = async () => {};

  return {
    name: 'timers',
    version: '0.1.0',

    init(ctx: ServiceContext) {
      const say = (channel: string, msg: string) => ctx.chat.say(channel, msg);

      // Loop mode skips fires while offline; the shared StreamService caches this.
      const isLive = () => ctx.stream.isLive();

      // Run a bound command as the broadcaster, without any chat-side effects.
      const fire = async (command: string): Promise<void> => {
        const b = await ctx.stream.broadcaster();
        if (!b) {
          ctx.logger.warn({ command }, 'timers: cannot fire — broadcaster not resolved');
          return;
        }
        await ctx.commands.execute(command, {
          channel: ctx.config.twitch.channel,
          ts: Date.now(),
          user: { id: b.id, login: b.login, displayName: b.displayName, permission: PermissionLevel.Broadcaster },
        });
      };

      ctx.timers.configure({ fire, isLive, logger: ctx.logger });
      stopRuntime = () => ctx.timers.stopAllRuntime();
      resume = () => ctx.timers.resumeLoops();

      // ── Argument parsing (bad input throws a TimerError → router replies) ──────
      // add/edit: "<name> <period> <!command> [options]".
      const parseDef = (e: CommandEvent) => {
        const parts = e.argString.trim().split(/\s+/).filter(Boolean);
        if (parts.length < 3) {
          throw new TimerError('Usage: <name> <periodSeconds> <!command> [options]');
        }
        return { name: parts[0]!, period: Number(parts[1]), command: parts.slice(2).join(' ') };
      };
      const nameArg = (e: CommandEvent) => {
        const name = e.argString.trim().split(/\s+/)[0] ?? '';
        if (!name) throw new TimerError('Provide a timer name.');
        return name;
      };

      ctx.commands.registerGroup('timer', {
        description:
          'Manage timers (mods+): add, start, loop, stop, status, delete, edit. A timer fires a bound !command once (start) or every period (loop).',
        permission: PermissionLevel.Moderator,
        subcommands: {
          add: {
            description: 'Create a timer bound to a command: !timer add <name> <periodSeconds> <!command> [options].',
            usage: '<name> <periodSeconds> <!command> [options]',
            aliases: ['new', 'create', 'make'],
            handler: async (e) => {
              const { name, period, command } = parseDef(e);
              const t = await ctx.timers.add(name, period, command);
              await say(e.channel, `Timer "${t.name}" created — runs ${t.command} every ${t.periodSeconds}s. Start it with !timer start ${t.name} or !timer loop ${t.name}.`);
            },
          },
          start: {
            description: 'Start a one-shot: fire the timer’s command once after its period.',
            usage: '<name>',
            aliases: ['go', 'activate', 'begin', 'enable'],
            handler: async (e) => {
              const t = await ctx.timers.start(nameArg(e));
              await say(e.channel, `Timer "${t.name}" started — ${t.command} fires in ${t.periodSeconds}s.`);
            },
          },
          loop: {
            description: 'Start loop mode: fire the timer’s command every period (skipped while offline, but stays armed).',
            usage: '<name>',
            aliases: ['repeat'],
            handler: async (e) => {
              const t = await ctx.timers.loop(nameArg(e));
              await say(e.channel, `Timer "${t.name}" looping — ${t.command} every ${t.periodSeconds}s.`);
            },
          },
          stop: {
            description: 'Disable loop mode (if any) and abort the current countdown.',
            usage: '<name>',
            aliases: ['end', 'abort', 'disable', 'cancel'],
            handler: async (e) => {
              const t = await ctx.timers.stop(nameArg(e));
              await say(e.channel, `Timer "${t.name}" stopped.`);
            },
          },
          status: {
            description: 'Report the time left on a timer.',
            usage: '<name>',
            aliases: ['remaining', 'timeleft'],
            handler: async (e) => {
              const name = nameArg(e);
              const t = await ctx.timers.get(name);
              if (!t) throw new TimerError(`No timer named "${name}".`);
              if (!t.running) {
                await say(e.channel, `Timer "${t.name}" is not running.`);
                return;
              }
              await say(e.channel, `Timer "${t.name}" fires in ${t.secondsLeft}s${t.mode === 'loop' ? ' (looping)' : ''}.`);
            },
          },
          delete: {
            description: 'Abort (if running) and delete a timer.',
            usage: '<name>',
            aliases: ['remove'],
            handler: async (e) => {
              const name = nameArg(e);
              await ctx.timers.delete(name);
              await say(e.channel, `Timer "${name}" deleted.`);
            },
          },
          edit: {
            description: 'Update a timer’s period and command: !timer edit <name> <periodSeconds> <!command> [options].',
            usage: '<name> <periodSeconds> <!command> [options]',
            aliases: ['update', 'modify', 'change'],
            handler: async (e) => {
              const { name, period, command } = parseDef(e);
              const t = await ctx.timers.edit(name, period, command);
              await say(e.channel, `Timer "${t.name}" updated — runs ${t.command} every ${t.periodSeconds}s.`);
            },
          },
        },
      });
    },

    // Resume armed loops after all plugins are initialized.
    async start() {
      await resume();
    },

    // Clear all in-memory countdowns on shutdown.
    stop() {
      stopRuntime();
    },
  };
}
