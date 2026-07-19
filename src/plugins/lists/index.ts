import type { Plugin } from '../types.js';
import type { ServiceContext } from '../../core/serviceContext.js';
import type { CommandEvent } from '../../core/events.js';
import { PermissionLevel } from '../../core/events.js';
import { ListError, listRestrictKeywordToLevel, normalizeListName, type Actor } from '../../services/lists.js';
import { toCsv } from '../../services/csv.js';

const LEVEL_LABEL = ['Everyone', 'Subscriber', 'VIP', 'Moderator', 'Broadcaster', 'Admin'];

/** Split the leading list-name token from the remaining text. */
function firstAndRest(input: string): { first: string; rest: string } {
  const s = input.trim();
  const i = s.indexOf(' ');
  if (i === -1) return { first: s, rest: '' };
  return { first: s.slice(0, i), rest: s.slice(i + 1).trim() };
}

/**
 * Named lists: the `!list …` manager (mods+), plus `!list add` which anyone
 * meeting the list's own permission level can use. Lists record their creator and
 * each entry's author. Management (rename/description/clear/delete/restrict) is
 * mod+; but a list restricted above Moderator (Broadcaster/Admin) blocks mods
 * from managing OR reading it — only that level and above may act on it.
 */
export function listsPlugin(): Plugin {
  return {
    name: 'lists',
    version: '0.1.0',

    init(ctx: ServiceContext) {
      const svc = ctx.lists;
      const say = (ch: string, msg: string) => ctx.chat.say(ch, msg);
      const actor = (e: CommandEvent): Actor => ({ id: e.user.id, displayName: e.user.displayName });
      const label = (name: string, display: string | null | undefined) => (display && display.trim()) || name;

      // Show CommandErrors (ListError) to the user instead of throwing to the router.
      const guard =
        (fn: (e: CommandEvent) => Promise<void>) =>
        async (e: CommandEvent): Promise<void> => {
          try {
            await fn(e);
          } catch (err) {
            if (err instanceof ListError) await say(e.channel, err.message);
            else throw err;
          }
        };

      // For management/read subcommands (already gated Mod+ by the router): if the
      // list is restricted above Moderator, block anyone below that level too.
      const assertMayManage = async (name: string, e: CommandEvent) => {
        const level = await svc.addPermission(name); // throws ListError if unknown
        if (level > PermissionLevel.Moderator && e.user.permission < level) {
          throw new ListError(`"${normalizeListName(name)}" is restricted to ${LEVEL_LABEL[level]}+.`);
        }
      };

      ctx.commands.registerGroup('list', {
        description:
          'Manage custom lists (mods+). Subcommands: new, displayname, description, removelist, restrict, clear, add, random, rename. Anyone allowed by a list can use "add".',
        permission: PermissionLevel.Moderator,
        subcommands: {
          new: {
            description: 'Create a new named list. The reference name is a single word; an optional longer display name may follow.',
            usage: '<listName> [display name]',
            handler: guard(async (e) => {
              const { first, rest } = firstAndRest(e.argString);
              await ctx.users.touch(e.user);
              const list = await svc.create(first, rest, actor(e));
              await say(e.channel, `Created list "${label(list.name, list.displayName)}" (add access: ${LEVEL_LABEL[list.addPermission]}+).`);
            }),
          },
          displayname: {
            description: 'Change the display name of a list.',
            usage: '<listName> <display name>',
            handler: guard(async (e) => {
              const { first, rest } = firstAndRest(e.argString);
              await assertMayManage(first, e);
              await svc.setDisplayName(first, rest);
              await say(e.channel, rest.trim() ? `Set display name of "${normalizeListName(first)}".` : `Cleared display name of "${normalizeListName(first)}".`);
            }),
          },
          description: {
            description: 'Change the description of a list.',
            usage: '<listName> <description>',
            handler: guard(async (e) => {
              const { first, rest } = firstAndRest(e.argString);
              await assertMayManage(first, e);
              await svc.setDescription(first, rest);
              await say(e.channel, `Updated the description of "${normalizeListName(first)}".`);
            }),
          },
          removelist: {
            description: 'Delete a list and all of its entries.',
            usage: '<listName>',
            handler: guard(async (e) => {
              const { first } = firstAndRest(e.argString);
              await assertMayManage(first, e);
              await svc.remove(first);
              await say(e.channel, `Deleted list "${normalizeListName(first)}".`);
            }),
          },
          restrict: {
            description: 'Set the permission level required to add to a list (All/Sub/VIP/Mod/Broadcaster/Admin).',
            usage: '<listName> <All/Sub/VIP/Mod/Broadcaster/Admin>',
            handler: guard(async (e) => {
              const { first, rest } = firstAndRest(e.argString);
              await assertMayManage(first, e);
              const level = listRestrictKeywordToLevel(rest);
              if (level === null) throw new ListError('Restrict to one of: All, Sub, VIP, Mod, Broadcaster, Admin.');
              await svc.setPermission(first, level);
              await say(e.channel, `"${normalizeListName(first)}" now allows ${LEVEL_LABEL[level]}+ to add entries.`);
            }),
          },
          clear: {
            description: 'Clear all entries in a list.',
            usage: '<listName>',
            handler: guard(async (e) => {
              const { first } = firstAndRest(e.argString);
              await assertMayManage(first, e);
              const n = await svc.clear(first);
              await say(e.channel, `Cleared ${n} ${n === 1 ? 'entry' : 'entries'} from "${normalizeListName(first)}".`);
            }),
          },
          rename: {
            description: 'Change the reference name of a list.',
            usage: '<listName> <newListName>',
            handler: guard(async (e) => {
              const { first, rest } = firstAndRest(e.argString);
              await assertMayManage(first, e);
              await svc.rename(first, rest);
              await say(e.channel, `Renamed "${normalizeListName(first)}" to "${normalizeListName(rest)}".`);
            }),
          },
          add: {
            // Anyone may attempt; the list's own permission is enforced in-handler.
            description: 'Add an entry to a list (permission is set per list).',
            usage: '<listName> <new entry>',
            permission: PermissionLevel.Viewer,
            handler: guard(async (e) => {
              const { first, rest } = firstAndRest(e.argString);
              const level = await svc.addPermission(first); // throws if unknown
              if (e.user.permission < level) {
                await say(e.channel, `Only ${LEVEL_LABEL[level]}+ can add to "${normalizeListName(first)}".`);
                return;
              }
              await ctx.users.touch(e.user);
              await svc.addEntry(first, rest, actor(e));
              await say(e.channel, `@${e.user.displayName} added an entry to "${normalizeListName(first)}".`);
            }),
          },
          random: {
            description: 'Print a random entry from a list.',
            usage: '<listName>',
            handler: guard(async (e) => {
              const { first } = firstAndRest(e.argString);
              await assertMayManage(first, e);
              const entry = await svc.random(first);
              await say(e.channel, entry ? entry : `"${normalizeListName(first)}" has no entries yet.`);
            }),
          },
          all: {
            description: 'Dump a whole list as a comma-separated line: "<Display Name>: a, b, c".',
            usage: '<listName>',
            aliases: ['dump', 'show'],
            handler: guard(async (e) => {
              const { first } = firstAndRest(e.argString);
              await assertMayManage(first, e);
              const entries = await svc.entriesOf(first); // null only if unknown, which assertMayManage already rejected
              const title = label(first, await svc.displayNameOf(first));
              await say(e.channel, `${title}: ${entries?.length ? toCsv([entries]) : '(empty)'}`);
            }),
          },
        },
      });
    },
  };
}
