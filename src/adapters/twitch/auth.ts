import { RefreshingAuthProvider, type AccessToken } from '@twurple/auth';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { AppConfig } from '../../services/config.js';
import { scopedLogger } from '../../services/logger.js';

const log = scopedLogger('twitch-auth');
const TOKEN_DIR = path.resolve(process.env.TOKEN_DIR ?? '.tokens');

type Role = 'bot' | 'broadcaster';
const TOKEN_FILES: Record<Role, string> = { bot: 'bot.json', broadcaster: 'broadcaster.json' };

/** Load a persisted token for a role, or fall back to the seed token from .env. */
async function loadToken(role: Role, seed: { accessToken: string; refreshToken: string }): Promise<AccessToken> {
  const file = path.join(TOKEN_DIR, TOKEN_FILES[role]);
  try {
    const data = JSON.parse(await fs.readFile(file, 'utf8')) as AccessToken;
    if (data.refreshToken) {
      log.debug({ role }, 'using persisted token');
      return data;
    }
  } catch {
    // No persisted token yet — first run for this role.
  }
  return {
    accessToken: seed.accessToken,
    refreshToken: seed.refreshToken,
    expiresIn: 0,
    obtainmentTimestamp: 0,
    scope: [],
  };
}

/**
 * Build a RefreshingAuthProvider holding TWO user tokens:
 *
 *  - the **bot account** (tagged with the `chat` intent) — used by ChatClient
 *    to read/write chat as BasecaBot.
 *  - the **broadcaster account** — used by EventSub, because scopes like
 *    channel:read:subscriptions and bits:read can only be authorized by the
 *    channel owner. Twurple resolves this token by the broadcaster's user id.
 *
 * Tokens are seeded from `.env` on first run, but on every subsequent start we
 * prefer the **persisted** token in `TOKEN_DIR/<role>.json`. This matters for a
 * long-running server: Twitch rotates refresh tokens, so after the first refresh
 * the value in `.env` is stale — relying on it would break the bot on restart.
 */
export async function createAuthProvider(config: AppConfig): Promise<RefreshingAuthProvider> {
  const authProvider = new RefreshingAuthProvider({
    clientId: config.twitch.clientId,
    clientSecret: config.twitch.clientSecret,
  });

  const roleByUserId = new Map<string, Role>();

  authProvider.onRefresh(async (userId, token) => {
    const role = roleByUserId.get(userId);
    if (!role) return;
    await fs.mkdir(TOKEN_DIR, { recursive: true });
    await fs.writeFile(path.join(TOKEN_DIR, TOKEN_FILES[role]), JSON.stringify(token, null, 2));
    log.debug({ role, userId }, 'refreshed and persisted token');
  });

  // Bot account → chat. The `chat` intent is how ChatClient finds this user.
  const botToken = await loadToken('bot', {
    accessToken: config.twitch.botAccessToken,
    refreshToken: config.twitch.botRefreshToken,
  });
  const botUserId = await authProvider.addUserForToken(botToken, ['chat']);
  roleByUserId.set(botUserId, 'bot');

  // Broadcaster account → EventSub (subs/bits/follows read scopes).
  const broadcasterToken = await loadToken('broadcaster', {
    accessToken: config.twitch.broadcasterAccessToken,
    refreshToken: config.twitch.broadcasterRefreshToken,
  });
  const broadcasterUserId = await authProvider.addUserForToken(broadcasterToken);
  roleByUserId.set(broadcasterUserId, 'broadcaster');

  return authProvider;
}
