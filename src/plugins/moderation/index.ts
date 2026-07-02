import type { Plugin } from '../types.js';
import type { ServiceContext } from '../../core/serviceContext.js';
import { PermissionLevel } from '../../core/events.js';

const DEFAULT_BANNED = ['badword1', 'badword2'];
const PERMIT_WINDOW_MS = 60_000;
const URL_RE = /\b(?:https?:\/\/|www\.)\S+/i;

/**
 * Lightweight auto-moderation: banned-word matching and link filtering, with a
 * !permit escape hatch. Deletion/timeout requires moderator scopes on the API
 * client; until that's wired we warn in chat (swap in api.moderation.* later).
 *
 * Banned words are stored in the Setting table (key "moderation.bannedWords",
 * comma-separated) so they're editable per-channel at runtime.
 */
export function moderationPlugin(): Plugin {
  const permits = new Map<string, number>(); // login -> expiry ms

  return {
    name: 'moderation',
    version: '0.1.0',

    init(ctx: ServiceContext) {
      const prisma = ctx.storage.prisma;

      async function bannedWords(channel: string): Promise<string[]> {
        const setting = await prisma.setting.findUnique({
          where: { channel_key: { channel, key: 'moderation.bannedWords' } },
        });
        if (!setting) return DEFAULT_BANNED;
        return setting.value.split(',').map((w) => w.trim().toLowerCase()).filter(Boolean);
      }

      ctx.commands.register(
        'permit',
        async (e) => {
          const target = e.args[0]?.toLowerCase().replace(/^@/, '');
          if (!target) {
            await ctx.chat.say(e.channel, 'Usage: !permit <user>');
            return;
          }
          permits.set(target, Date.now() + PERMIT_WINDOW_MS);
          await ctx.chat.say(e.channel, `@${target} may post a link for the next 60s.`);
        },
        { permission: PermissionLevel.Moderator, description: '(Mod) Let a user post one link.' },
      );

      ctx.commands.register(
        'bannedwords',
        async (e) => {
          if (e.args[0]?.toLowerCase() === 'set') {
            const list = e.argString.slice(3).trim();
            await prisma.setting.upsert({
              where: { channel_key: { channel: e.channel, key: 'moderation.bannedWords' } },
              create: { channel: e.channel, key: 'moderation.bannedWords', value: list },
              update: { value: list },
            });
            await ctx.chat.say(e.channel, 'Banned word list updated.');
          } else {
            const list = await bannedWords(e.channel);
            await ctx.chat.say(e.channel, `Banned words: ${list.length} configured.`);
          }
        },
        { permission: PermissionLevel.Moderator, description: '(Mod) View/set banned words.' },
      );

      ctx.bus.on('chat', async (e) => {
        // Never moderate mods/broadcaster/admins.
        if (e.user.permission >= PermissionLevel.Moderator) return;
        const lower = e.message.toLowerCase();

        const words = await bannedWords(e.channel);
        if (words.some((w) => lower.includes(w))) {
          ctx.logger.info({ user: e.user.login }, 'banned word detected');
          await ctx.chat.say(e.channel, `@${e.user.displayName}, watch the language.`);
          return;
        }

        if (URL_RE.test(e.message)) {
          const expiry = permits.get(e.user.login) ?? 0;
          if (Date.now() < expiry) {
            permits.delete(e.user.login); // one-time permit
            return;
          }
          ctx.logger.info({ user: e.user.login }, 'unpermitted link');
          await ctx.chat.say(e.channel, `@${e.user.displayName}, please ask a mod before posting links.`);
        }
      });
    },
  };
}
