import type { Plugin } from '../types.js';
import type { ServiceContext } from '../../core/serviceContext.js';
import type { CommandEvent } from '../../core/events.js';
import { PermissionLevel } from '../../core/events.js';
import {
  CommandError,
  parseTarget,
  describeTarget,
  restrictKeywordToLevel,
} from '../../services/customCommands.js';
import { CommandVarEngine, type VarContext } from '../../services/commandVars.js';

/**
 * Custom commands: the mod-facing `!command …` manager (each subcommand
 * registered so the dashboard can document it), plus the runtime that serves
 * custom commands — `!trigger` words (via the CommandRouter fallback) and
 * "phrase" matches (by scanning chat). Enable state, permissions, global/user
 * cooldowns, and usage counts are enforced/tracked by the CustomCommandService.
 *
 * Responses support the $(…)/${…} variable engine (see services/commandVars.ts
 * + docs). An empty response is a silent command: it still fires (usage++,
 * cooldowns) but says nothing.
 */
export function commandsPlugin(): Plugin {
  return {
    name: 'commands',
    version: '0.4.0',

    init(ctx: ServiceContext) {
      const svc = ctx.customCommands;
      const say = (channel: string, msg: string) => ctx.chat.say(channel, msg);

      const vars = new CommandVarEngine({
        points: ctx.points,
        users: ctx.users,
        quotes: ctx.quotes,
        lists: ctx.lists,
        customCommands: ctx.customCommands,
        api: ctx.api,
        broadcasterUsername: ctx.config.twitch.broadcasterUsername,
        pointsName: ctx.config.points.name,
        logger: ctx.logger,
      });

      // Render a custom-command response through the $()/${} variable engine.
      const renderResponse = (
        cmdName: string,
        response: string,
        e: { user: { id: string; login: string; displayName: string }; channel: string },
        argString: string,
        args: string[],
        count: number,
      ): Promise<string> => {
        const u = e.user;
        const context: VarContext = {
          sender: { id: u.id, login: u.login, displayName: u.displayName },
          channel: e.channel,
          args,
          argString,
          command: { name: cmdName, count },
        };
        return vars.render(response, context);
      };

      // Parse the leading `!trigger` or `"phrase"` target from a subcommand's args.
      const target = (e: CommandEvent) => {
        const parsed = parseTarget(e.argString);
        if (!parsed) throw new CommandError('Specify a target as !trigger or "phrase".');
        return parsed;
      };
      // Wrap a subcommand handler so CommandErrors are shown to the user in chat.
      const guard =
        (fn: (e: CommandEvent) => Promise<void>) =>
        async (e: CommandEvent): Promise<void> => {
          try {
            await fn(e);
          } catch (err) {
            if (err instanceof CommandError) await say(e.channel, err.message);
            else throw err;
          }
        };

      // ── Mod manager: !command <sub> [!trigger or "phrase"] … ────────────────
      ctx.commands.registerGroup('command', {
        description:
          'Manage custom commands (mods+). Subcommands: add, response, setgroup, cooldown, restrict, setcount, enable, disable, addalias, remove — target a !trigger, "phrase", or (for enable/disable/remove) a !alias.',
        permission: PermissionLevel.Moderator,
        aliases: ['cmd'],
        subcommands: {
          add: {
            description: 'Add a command: !command add [!trigger or "phrase"] [message].',
            usage: '<!trigger or "phrase"> [message]',
            handler: guard(async (e) => {
              const t = target(e);
              await svc.create(t.target, { response: t.rest });
              await say(e.channel, `Added ${describeTarget(t.target)}.`);
            }),
          },
          response: {
            description: 'Update a command’s response message.',
            usage: '<!trigger or "phrase"> [message]',
            handler: guard(async (e) => {
              const t = target(e);
              await svc.setResponse(t.target, t.rest);
              await say(e.channel, `Updated response for ${describeTarget(t.target)}.`);
            }),
          },
          setgroup: {
            description: 'Set the group of the command (e.g. People, Pets, Facts).',
            usage: '<!trigger or "phrase"> <group>',
            handler: guard(async (e) => {
              const t = target(e);
              await svc.setGroup(t.target, t.rest);
              await say(
                e.channel,
                t.rest.trim()
                  ? `Set group for ${describeTarget(t.target)} to "${t.rest.trim()}".`
                  : `Cleared group for ${describeTarget(t.target)}.`,
              );
            }),
          },
          setcount: {
            description: 'Set a command’s usage count.',
            usage: '<!trigger or "phrase"> [count]',
            handler: guard(async (e) => {
              const t = target(e);
              const count = Number.parseInt(t.rest, 10);
              if (!Number.isFinite(count)) throw new CommandError('Provide a numeric count.');
              await svc.setUsageCount(t.target, count);
              await say(e.channel, `Set usage count for ${describeTarget(t.target)} to ${Math.max(0, count)}.`);
            }),
          },
          cooldown: {
            description: 'Set cooldowns. If only one value is given it sets the global cooldown.',
            usage: '<!trigger or "phrase"> <globalSecs> [userSecs]',
            handler: guard(async (e) => {
              const t = target(e);
              const parts = t.rest.split(/\s+/).filter(Boolean);
              const g = Number.parseInt(parts[0] ?? '', 10);
              if (!Number.isFinite(g)) throw new CommandError('Usage: !command cooldown [target] [globalSecs] [userSecs?]');
              const u = parts[1] !== undefined ? Number.parseInt(parts[1], 10) : undefined;
              await svc.setCooldown(t.target, g, u);
              await say(e.channel, `Updated cooldowns for ${describeTarget(t.target)}.`);
            }),
          },
          restrict: {
            description: 'Update the permission level required to use a command.',
            usage: '<!trigger or "phrase"> <Level>',
            handler: guard(async (e) => {
              const t = target(e);
              const level = restrictKeywordToLevel(t.rest);
              if (level === null) throw new CommandError('Restrict to one of: All, Sub, VIP, Mod, Broadcaster, Admin.');
              await svc.setPermission(t.target, level);
              await say(e.channel, `Restricted ${describeTarget(t.target)} to ${t.rest.trim()}.`);
            }),
          },
          enable: {
            description: 'Enable a command or an alias.',
            usage: '<!trigger, "phrase", or !alias>',
            handler: guard(async (e) => {
              const t = target(e);
              await svc.setEnabled(t.target, true);
              await say(e.channel, `Enabled ${describeTarget(t.target)}.`);
            }),
          },
          disable: {
            description: 'Disable a command or an alias (keeps it in the database).',
            usage: '<!trigger, "phrase", or !alias>',
            handler: guard(async (e) => {
              const t = target(e);
              await svc.setEnabled(t.target, false);
              await say(e.channel, `Disabled ${describeTarget(t.target)}.`);
            }),
          },
          addalias: {
            description: 'Add an alias for a custom OR built-in command, with optional pre-baked args (may contain $() vars): !command addalias <!alias> <!trigger> [args]. E.g. !command addalias !addme !wheel add $(sender).',
            usage: '<!alias> <!trigger> [arguments]',
            handler: guard(async (e) => {
              const first = parseTarget(e.argString);
              if (!first || first.target.kind !== 'trigger') throw new CommandError('Usage: !command addalias <!alias> <!trigger> [args]');
              const second = parseTarget(first.rest);
              if (!second || second.target.kind !== 'trigger') throw new CommandError('Provide the command to alias, e.g. !command addalias <!alias> <!trigger> [args].');
              await svc.addAlias(first.target.name, second.target.name, second.rest);
              await say(e.channel, `Added alias !${first.target.name} → !${second.target.name}${second.rest ? ' ' + second.rest : ''}.`);
            }),
          },
          remove: {
            description: 'Remove a command (and all its aliases), or just one alias if an alias trigger is given.',
            usage: '<!trigger or !alias or "phrase">',
            handler: guard(async (e) => {
              const t = target(e);
              const res = await svc.remove(t.target);
              if (res.type === 'alias') {
                await say(e.channel, `Removed alias ${res.alias} from ${res.command}.`);
              } else if (res.aliases.length) {
                await say(e.channel, `Removed ${res.label} and its alias${res.aliases.length > 1 ? 'es' : ''}: ${res.aliases.join(', ')}.`);
              } else {
                await say(e.channel, `Removed ${res.label}.`);
              }
            }),
          },
        },
      });

      // ── Trigger runtime: unknown `!word` -> custom trigger command or alias ──
      ctx.commands.setFallback(async (e) => {
        const match = await svc.findByTrigger(e.name);
        if (!match) return;

        // A built-in alias re-dispatches to a built-in command with pre-baked
        // args: `!addme` -> `!wheel add $(sender)`. The built-in's own
        // permission/cooldown apply (checked by dispatchBuiltin).
        if (match.kind === 'builtin') {
          const a = match.builtin;
          if (!a.enabled) return; // a disabled alias is a no-op
          const baked = a.args
            ? (
                await vars.render(a.args, {
                  sender: { id: e.user.id, login: e.user.login, displayName: e.user.displayName },
                  channel: e.channel,
                  args: e.args,
                  argString: e.argString,
                  command: { name: a.word, count: 0 },
                })
              ).trim()
            : '';
          // !<builtin> <baked args> <caller's args>
          const message = ['!' + a.targetWord, baked, e.argString].filter((s) => s).join(' ');
          await ctx.commands.dispatchBuiltin(message, { channel: e.channel, ts: e.ts, user: e.user });
          return;
        }

        const { command, alias } = match;
        if (alias && !alias.enabled) return; // a disabled alias is a no-op
        // The COMMAND's enable/permission/cooldown gate applies (so a disabled
        // root command is a no-op even when the alias itself is enabled).
        if (!svc.canTrigger(command, e.user.id, e.user.permission)) return;
        const count = svc.recordUse(command, e.user.id);
        if (!command.response) return; // silent

        let argString = e.argString;
        let args = e.args;
        if (alias && alias.args) {
          // Resolve the alias's extra args ($() vars included), then prepend to the caller's.
          const resolved = (
            await vars.render(alias.args, {
              sender: { id: e.user.id, login: e.user.login, displayName: e.user.displayName },
              channel: e.channel,
              args: e.args,
              argString: e.argString,
              command: { name: command.name, count },
            })
          ).trim();
          argString = `${resolved} ${e.argString}`.trim();
          args = argString.length ? argString.split(/\s+/) : [];
        }
        await say(e.channel, await renderResponse(command.name, command.response, e, argString, args, count));
      });

      // ── Phrase runtime: fire on phrases appearing in normal chat ────────────
      ctx.bus.on('chat', async (e) => {
        if (e.user.login === ctx.config.twitch.botUsername) return; // ignore the bot itself
        const matches = svc.matchPhrases(e.message);
        for (const cmd of matches) {
          if (!svc.canTrigger(cmd, e.user.id, e.user.permission)) continue;
          const count = svc.recordUse(cmd, e.user.id);
          if (cmd.response) {
            const words = e.message.split(/\s+/).filter(Boolean);
            await say(e.channel, await renderResponse(cmd.name, cmd.response, e, e.message, words, count));
          }
          break; // at most one phrase fires per message, to avoid chat spam
        }
      });
    },
  };
}
