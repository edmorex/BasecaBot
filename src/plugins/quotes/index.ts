import type { Plugin } from '../types.js';
import type { ServiceContext } from '../../core/serviceContext.js';
import type { CommandEvent } from '../../core/events.js';
import { PermissionLevel } from '../../core/events.js';
import { QuoteError, formatQuote, type QuoteView } from '../../services/quotes.js';

/** Split the leading token (usually a quote ID) from the remaining text. */
function firstAndRest(input: string): { first: string; rest: string } {
  const s = input.trim();
  const i = s.indexOf(' ');
  if (i === -1) return { first: s, rest: '' };
  return { first: s.slice(0, i), rest: s.slice(i + 1).trim() };
}

function parseId(word: string): number | null {
  return /^\d+$/.test(word) ? Number.parseInt(word, 10) : null;
}

/**
 * Quotes: `!quote` shows a random quote, `!quote <id>` a specific one, and the
 * search subcommands recall by text/user/date/game. Subscribers can `add`;
 * editing/removing is mod+. Each quote records who added it and the game that was
 * live when it was captured.
 */
export function quotesPlugin(): Plugin {
  let broadcasterId: string | undefined;

  return {
    name: 'quotes',
    version: '0.1.0',

    init(ctx: ServiceContext) {
      const svc = ctx.quotes;
      const say = (ch: string, msg: string) => ctx.chat.say(ch, msg);

      const getBroadcasterId = async (): Promise<string | undefined> => {
        if (broadcasterId) return broadcasterId;
        const u = await ctx.api.users.getUserByName(ctx.config.twitch.broadcasterUsername);
        broadcasterId = u?.id;
        return broadcasterId;
      };
      const currentGame = async (): Promise<string | null> => {
        try {
          const bid = await getBroadcasterId();
          if (!bid) return null;
          const info = await ctx.api.channels.getChannelInfoById(bid);
          return info?.gameName?.trim() || null;
        } catch (err) {
          ctx.logger.warn({ err }, 'quotes: could not fetch current game');
          return null;
        }
      };

      // Surface QuoteErrors to chat instead of throwing to the router.
      const guard =
        (fn: (e: CommandEvent) => Promise<void>) =>
        async (e: CommandEvent): Promise<void> => {
          try {
            await fn(e);
          } catch (err) {
            if (err instanceof QuoteError) await say(e.channel, err.message);
            else throw err;
          }
        };

      // An edit subcommand: first arg is the ID, the rest is the new value.
      const editHandler = (
        label: string,
        apply: (id: number, value: string) => Promise<QuoteView>,
      ) =>
        guard(async (e) => {
          const { first, rest } = firstAndRest(e.argString);
          const id = parseId(first);
          if (id === null) throw new QuoteError(`Usage: !quote ${label} <quoteId> <new value>`);
          await say(e.channel, formatQuote(await apply(id, rest)));
        });

      ctx.commands.registerGroup('quote', {
        description:
          'Quotes: !quote (random), !quote <id>, and search/searchuser/searchdate/searchgame print quotes (anyone). Subs can add. Mods: remove, edittext, edituser, editgame, editdate.',
        permission: PermissionLevel.Viewer,
        // Bare `!quote` or `!quote <id>` (no matching subcommand).
        onUnknown: guard(async (e) => {
          const id = e.args[0] ? parseId(e.args[0]) : null;
          if (id !== null) {
            await say(e.channel, formatQuote(await svc.getById(id)));
            return;
          }
          const q = await svc.random();
          await say(e.channel, q ? formatQuote(q) : 'No quotes yet.');
        }),
        subcommands: {
          add: {
            description:
              'Add a new quote: !quote add <username> <quote text>. The name can be an @handle, display name, or alias.',
            usage: '<username> <quoteText>',
            permission: PermissionLevel.Subscriber,
            handler: guard(async (e) => {
              const { first, rest } = firstAndRest(e.argString);
              if (!first || !rest.trim()) throw new QuoteError('Usage: !quote add <username> <quote text>');
              await ctx.users.touch(e.user);
              const game = await currentGame();
              const quote = await svc.add({ user: first, text: rest, game }, { id: e.user.id, displayName: e.user.displayName });
              await say(e.channel, `Added ${formatQuote(quote)}`);
            }),
          },
          remove: {
            description: 'Remove a quote by its ID.',
            usage: '<quoteId>',
            permission: PermissionLevel.Moderator,
            handler: guard(async (e) => {
              const id = parseId(firstAndRest(e.argString).first);
              if (id === null) throw new QuoteError('Usage: !quote remove <quoteId>');
              await svc.remove(id);
              await say(e.channel, `Removed quote ${id}.`);
            }),
          },
          edittext: {
            description: 'Edit the text of a quote.',
            usage: '<quoteId> <newText>',
            permission: PermissionLevel.Moderator,
            handler: editHandler('edittext', (id, v) => svc.setText(id, v)),
          },
          edituser: {
            description: 'Edit the user a quote is attributed to (any of their names).',
            usage: '<quoteId> <newUsername>',
            permission: PermissionLevel.Moderator,
            handler: editHandler('edituser', (id, v) => svc.setUser(id, v)),
          },
          editgame: {
            description: 'Edit the game recorded on a quote.',
            usage: '<quoteId> <newGame>',
            permission: PermissionLevel.Moderator,
            handler: editHandler('editgame', (id, v) => svc.setGame(id, v)),
          },
          editdate: {
            description: 'Edit the date of a quote (YYYY MM DD).',
            usage: '<quoteId> <newDate>',
            permission: PermissionLevel.Moderator,
            handler: editHandler('editdate', (id, v) => svc.setDate(id, v)),
          },
          search: {
            description: 'Print a random quote matching the search term(s).',
            usage: '<searchTerm>',
            handler: guard(async (e) => {
              const q = await svc.searchText(e.argString);
              await say(e.channel, q ? formatQuote(q) : 'No quotes matched that search.');
            }),
          },
          searchuser: {
            description: 'Print a random quote said by the given user (any of their names).',
            usage: '<username>',
            handler: guard(async (e) => {
              const q = await svc.searchUser(e.argString);
              await say(e.channel, q ? formatQuote(q) : 'No quotes from that user.');
            }),
          },
          searchdate: {
            description: 'Print a random quote from the given date (YYYY MM DD).',
            usage: '<YYYY MM DD>',
            handler: guard(async (e) => {
              const q = await svc.searchDate(e.argString);
              await say(e.channel, q ? formatQuote(q) : 'No quotes from that date.');
            }),
          },
          searchgame: {
            description: 'Print a random quote captured during the given game.',
            usage: '<searchTerm>',
            handler: guard(async (e) => {
              const q = await svc.searchGame(e.argString);
              await say(e.channel, q ? formatQuote(q) : 'No quotes from that game.');
            }),
          },
        },
      });
    },
  };
}
