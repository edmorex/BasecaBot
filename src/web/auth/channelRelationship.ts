import type { ApiClient } from '@twurple/api';
import type { AppConfig } from '../../services/config.js';
import { scopedLogger } from '../../services/logger.js';
import type { ChannelRelationship, SessionUser } from './types.js';

const log = scopedLogger('channelRelationship');

/**
 * Computes a visitor's relationship to the bot's channel: broadcaster, bot
 * admin, moderator, subscriber, follower.
 *
 * - broadcaster / botAdmin are derived from ids + config (no API call).
 * - moderator / subscriber / follower are Helix lookups made with the
 *   BROADCASTER's token (the shared ApiClient), because those read scopes can
 *   only be authorized by the channel owner:
 *     moderator  -> moderation:read
 *     subscriber -> channel:read:subscriptions
 *     follower   -> moderator:read:followers
 *   Each lookup is isolated: if a scope is missing or the call fails, that field
 *   degrades to `false` (logged) rather than failing the whole login.
 */
export class ChannelRelationshipService {
  constructor(
    private readonly api: ApiClient,
    private readonly config: AppConfig,
    private readonly broadcasterId: string,
  ) {}

  async compute(user: SessionUser): Promise<ChannelRelationship> {
    const isBroadcaster = user.id === this.broadcasterId;
    const botAdmin = this.config.twitch.admins.includes(user.login.toLowerCase());

    // The broadcaster implicitly has every relationship; skip the API calls.
    if (isBroadcaster) {
      return { broadcaster: true, botAdmin: true, moderator: true, subscriber: true, follower: true };
    }

    const [moderator, subscriber, follower] = await Promise.all([
      this.check('moderator', () => this.api.moderation.checkUserMod(this.broadcasterId, user.id)),
      this.check('subscriber', async () => {
        const sub = await this.api.subscriptions.getSubscriptionForUser(this.broadcasterId, user.id);
        return sub !== null;
      }),
      this.check('follower', async () => {
        const followers = await this.api.channels.getChannelFollowers(this.broadcasterId, user.id);
        return followers.data.length > 0;
      }),
    ]);

    return { broadcaster: false, botAdmin, moderator, subscriber, follower };
  }

  private async check(label: string, fn: () => Promise<boolean>): Promise<boolean> {
    try {
      return await fn();
    } catch (err) {
      log.warn({ err, check: label }, 'relationship check failed (missing scope?) — treating as false');
      return false;
    }
  }
}
