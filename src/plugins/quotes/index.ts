import type { Plugin } from '../types.js';
import type { ServiceContext } from '../../core/serviceContext.js';
import type { CommandEvent } from '../../core/events.js';
import { PermissionLevel } from '../../core/events.js';
import { QuoteError, formatQuote, parseQuoteAddArgs, type QuoteView } from '../../services/quotes.js';
import { firstAndRest, plural } from '../../services/strings.js';

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
  return {
    name: 'quotes',
    version: '0.1.0',

    init(ctx: ServiceContext) {
      const svc = ctx.quotes;
      const say = (ch: string, msg: string) => ctx.chat.say(ch, msg);

      // Editable chat strings (Admin → Text Strings, feature "quotes"); blank = silent.
      // (Printing a found quote uses the structured formatter, not these.)
      const strings: Array<{ key: string; label: string; default: string; placeholders: string[] }> = [
        { key: 'none', label: 'No quotes saved', default: 'No quotes yet.', placeholders: [] },
        { key: 'added', label: 'Quote added', default: 'Added {quote}', placeholders: ['quote'] },
        { key: 'removed', label: 'Quote removed', default: 'Removed quote {id}.', placeholders: ['id'] },
        { key: 'noSearchMatch', label: 'Search — no match', default: 'No quotes matched that search.', placeholders: [] },
        { key: 'noUserMatch', label: 'Search by user — no match', default: 'No quotes from that user.', placeholders: [] },
        { key: 'noDateMatch', label: 'Search by date — no match', default: 'No quotes from that date.', placeholders: [] },
        { key: 'noGameMatch', label: 'Search by game — no match', default: 'No quotes from that game.', placeholders: [] },
        { key: 'help', label: 'Help', default: 'Quotes: !quote shows a random quote · !quote <id> shows a specific one · add one (subs+) with: !quote add <username> <text>  OR  !quote add "text" - Name. See them all at https://bot.edmorex.com/quotes', placeholders: [] },
        { key: 'count', label: 'Count — total', default: 'There {be} {count} {noun} saved.', placeholders: ['be', 'count', 'noun'] },
        { key: 'searchCount', label: 'Count — search matches', default: '{count} {noun} match “{term}”.', placeholders: ['count', 'noun', 'term'] },
        { key: 'searchUserCount', label: 'Count — by user', default: '{count} {noun} {be} attributed to {who}.', placeholders: ['count', 'noun', 'be', 'who'] },
      ];
      for (const s of strings) ctx.text.register({ feature: 'quotes', ...s });
      const sayText = ctx.text.sayer(ctx.chat, 'quotes'); // blank string = silent

      // An edit subcommand: first arg is the ID, the rest is the new value.
      const editHandler = (
        label: string,
        apply: (id: number, value: string) => Promise<QuoteView>,
      ) =>
        async (e: CommandEvent) => {
          const { first, rest } = firstAndRest(e.argString);
          const id = parseId(first);
          if (id === null) throw new QuoteError(`Usage: !quote ${label} <quoteId> <new value>`);
          await say(e.channel, formatQuote(await apply(id, rest)));
        };

      ctx.commands.registerGroup('quote', {
        description:
          'Quotes: !quote (random), !quote <id>, and search/searchuser/searchdate/searchgame print quotes (anyone). Subs can add. Mods: remove, edittext, edituser, editgame, editdate.',
        permission: PermissionLevel.Viewer,
        // Bare `!quote` or `!quote <id>` (no matching subcommand).
        onUnknown: async (e) => {
          const id = e.args[0] ? parseId(e.args[0]) : null;
          if (id !== null) {
            await say(e.channel, formatQuote(await svc.getById(id)));
            return;
          }
          const q = await svc.random();
          if (q) await say(e.channel, formatQuote(q));
          else await sayText(e.channel, 'none');
        },
        subcommands: {
          help: {
            description: 'Show how to use the quote commands.',
            handler: async (e) => {
              await sayText(e.channel, 'help');
            },
          },
          add: {
            description:
              'Add a new quote: !quote add <username> <quote text>, or !quote add "quote text" - Name. The name can be an @handle, display name, or alias.',
            usage: '<username> <quoteText>',
            permission: PermissionLevel.Subscriber,
            handler: async (e) => {
              // Accepts the standard `<username> <text>` and the alternate
              // `"text" - Name` form; throws a QuoteError on an unparseable input.
              const { user, text } = parseQuoteAddArgs(e.argString);
              await ctx.users.touch(e.user);
              const game = await ctx.stream.game();
              const quote = await svc.add({ user, text, game }, { id: e.user.id, displayName: e.user.displayName });
              await sayText(e.channel, 'added', { quote: formatQuote(quote) });
            },
          },
          remove: {
            description: 'Remove a quote by its ID.',
            usage: '<quoteId>',
            permission: PermissionLevel.Moderator,
            handler: async (e) => {
              const id = parseId(firstAndRest(e.argString).first);
              if (id === null) throw new QuoteError('Usage: !quote remove <quoteId>');
              await svc.remove(id);
              await sayText(e.channel, 'removed', { id });
            },
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
            aliases: ['about'],
            handler: async (e) => {
              const q = await svc.searchText(e.argString);
              if (q) await say(e.channel, formatQuote(q));
              else await sayText(e.channel, 'noSearchMatch');
            },
          },
          searchuser: {
            description: 'Print a random quote said by the given user (any of their names).',
            usage: '<username>',
            aliases: ['by'],
            handler: async (e) => {
              const q = await svc.searchUser(e.argString);
              if (q) await say(e.channel, formatQuote(q));
              else await sayText(e.channel, 'noUserMatch');
            },
          },
          searchdate: {
            description: 'Print a random quote from the given date (YYYY MM DD).',
            usage: '<YYYY MM DD>',
            handler: async (e) => {
              const q = await svc.searchDate(e.argString);
              if (q) await say(e.channel, formatQuote(q));
              else await sayText(e.channel, 'noDateMatch');
            },
          },
          searchgame: {
            description: 'Print a random quote captured during the given game.',
            usage: '<searchTerm>',
            handler: async (e) => {
              const q = await svc.searchGame(e.argString);
              if (q) await say(e.channel, formatQuote(q));
              else await sayText(e.channel, 'noGameMatch');
            },
          },
          count: {
            description: 'Say how many quotes are saved.',
            handler: async (e) => {
              const n = await svc.count();
              await sayText(e.channel, 'count', { be: plural(n, 'is', 'are'), count: n, noun: plural(n, 'quote', 'quotes') });
            },
          },
          searchcount: {
            description: 'Say how many quotes match the search term(s).',
            usage: '<searchTerm>',
            aliases: ['aboutcount'],
            handler: async (e) => {
              const term = e.argString.trim();
              const n = await svc.countText(term);
              await sayText(e.channel, 'searchCount', { count: n, noun: plural(n, 'quote', 'quotes'), term });
            },
          },
          searchusercount: {
            description: 'Say how many quotes are attributed to the given user.',
            usage: '<username>',
            aliases: ['bycount'],
            handler: async (e) => {
              const who = e.argString.trim();
              const n = await svc.countUser(who);
              await sayText(e.channel, 'searchUserCount', { count: n, noun: plural(n, 'quote', 'quotes'), be: plural(n, 'is', 'are'), who });
            },
          },
        },
      });
    },
  };
}
