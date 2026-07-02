import type { Plugin } from '../types.js';
import type { ServiceContext } from '../../core/serviceContext.js';
import { PermissionLevel } from '../../core/events.js';

/**
 * Admin-defined custom text commands. Managed at runtime via !addcom / !delcom /
 * !editcom and served through the CommandRouter's fallback resolver, so any
 * unknown `!name` is looked up in the DB.
 *
 * Supports simple variable substitution in responses: {user}, {channel}, {args}.
 */
export function commandsPlugin(): Plugin {
  return {
    name: 'commands',
    version: '0.1.0',

    init(ctx: ServiceContext) {
      const prisma = ctx.storage.prisma;

      ctx.commands.register(
        'addcom',
        async (e) => {
          const name = e.args[0]?.toLowerCase().replace(/^!/, '');
          const response = e.argString.slice(e.args[0]?.length ?? 0).trim();
          if (!name || !response) {
            await ctx.chat.say(e.channel, 'Usage: !addcom <name> <response>');
            return;
          }
          await prisma.customCommand.upsert({
            where: { channel_name: { channel: e.channel, name } },
            create: { channel: e.channel, name, response },
            update: { response },
          });
          await ctx.chat.say(e.channel, `Command !${name} saved.`);
        },
        { permission: PermissionLevel.Moderator, description: '(Mod) Add/update a custom command.' },
      );

      ctx.commands.register(
        'delcom',
        async (e) => {
          const name = e.args[0]?.toLowerCase().replace(/^!/, '');
          if (!name) {
            await ctx.chat.say(e.channel, 'Usage: !delcom <name>');
            return;
          }
          await prisma.customCommand
            .delete({ where: { channel_name: { channel: e.channel, name } } })
            .then(() => ctx.chat.say(e.channel, `Command !${name} deleted.`))
            .catch(() => ctx.chat.say(e.channel, `No command !${name} found.`));
        },
        { permission: PermissionLevel.Moderator, description: '(Mod) Delete a custom command.' },
      );

      // Fallback: resolve unknown commands against the DB.
      ctx.commands.setFallback(async (e) => {
        const cmd = await prisma.customCommand.findUnique({
          where: { channel_name: { channel: e.channel, name: e.name } },
        });
        if (!cmd) return;
        if (e.user.permission < cmd.permission) return;
        const response = cmd.response
          .replaceAll('{user}', e.user.displayName)
          .replaceAll('{channel}', e.channel)
          .replaceAll('{args}', e.argString);
        await ctx.chat.say(e.channel, response);
      });
    },
  };
}
