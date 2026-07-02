import { RefreshingAuthProvider } from '@twurple/auth';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { AppConfig } from '../../services/config.js';
import { scopedLogger } from '../../services/logger.js';

const log = scopedLogger('twitch-auth');
const TOKEN_DIR = path.resolve('.tokens');

/**
 * Build a RefreshingAuthProvider holding TWO user tokens:
 *
 *  - the **bot account** (tagged with the `chat` intent) — used by ChatClient
 *    to read/write chat as BasecaBot.
 *  - the **broadcaster account** — used by EventSub, because scopes like
 *    channel:read:subscriptions and bits:read can only be authorized by the
 *    channel owner. Twurple resolves this token by the broadcaster's user id.
 *
 * Twurple refreshes access tokens automatically; we persist each refreshed
 * token to `.tokens/<userId>.json` so restarts don't need fresh manual tokens.
 */
export async function createAuthProvider(config: AppConfig): Promise<RefreshingAuthProvider> {
  const authProvider = new RefreshingAuthProvider({
    clientId: config.twitch.clientId,
    clientSecret: config.twitch.clientSecret,
  });

  authProvider.onRefresh(async (userId, token) => {
    await fs.mkdir(TOKEN_DIR, { recursive: true });
    await fs.writeFile(path.join(TOKEN_DIR, `${userId}.json`), JSON.stringify(token, null, 2));
    log.debug({ userId }, 'refreshed and persisted token');
  });

  // Bot account → chat. The `chat` intent is how ChatClient finds this user.
  await authProvider.addUserForToken(
    {
      accessToken: config.twitch.botAccessToken,
      refreshToken: config.twitch.botRefreshToken,
      expiresIn: 0,
      obtainmentTimestamp: 0,
    },
    ['chat'],
  );

  // Broadcaster account → EventSub (subs/bits/follows read scopes).
  await authProvider.addUserForToken({
    accessToken: config.twitch.broadcasterAccessToken,
    refreshToken: config.twitch.broadcasterRefreshToken,
    expiresIn: 0,
    obtainmentTimestamp: 0,
  });

  return authProvider;
}
