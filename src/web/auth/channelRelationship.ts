import type { ApiClient } from '@twurple/api';
import type { AppConfig } from '../../services/config.js';
import { scopedLogger } from '../../services/logger.js';
import type { ChannelRelationship, SessionUser } from './types.js';

const log = scopedLogger('channelRelationship');

/** How long bulk role lists are reused before Twitch is asked again. */
const ROLE_CACHE_MS = 60_000;

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

  /**
   * Bulk role lookup for the admin Users table: one pass over the channel's
   * moderators, VIPs, and subscribers rather than three Helix calls per user.
   *
   * Results are cached briefly because the table refetches on every edit, and
   * each list degrades to empty independently — a missing scope costs that one
   * role, not the whole table. Callers still resolve broadcaster/admin from
   * config, which needs no API at all.
   */
  async roleSets(): Promise<{ moderators: Set<string>; vips: Set<string>; subscribers: Set<string> }> {
    const now = Date.now();
    if (this.roleCache && now - this.roleCache.at < ROLE_CACHE_MS) return this.roleCache.sets;

    const ids = async (label: string, fn: () => Promise<string[]>): Promise<Set<string>> => {
      try {
        return new Set(await fn());
      } catch (err) {
        log.warn({ err, check: label }, 'bulk role lookup failed (missing scope?) — treating as empty');
        return new Set<string>();
      }
    };

    const [moderators, vips, subscribers] = await Promise.all([
      ids('moderators', async () =>
        (await this.api.moderation.getModeratorsPaginated(this.broadcasterId).getAll()).map((m) => m.userId),
      ),
      // VIPs come back as plain user relations, keyed by `id` rather than `userId`.
      ids('vips', async () => (await this.api.channels.getVipsPaginated(this.broadcasterId).getAll()).map((v) => v.id)),
      ids('subscribers', async () =>
        (await this.api.subscriptions.getSubscriptionsPaginated(this.broadcasterId).getAll()).map((s) => s.userId),
      ),
    ]);

    const sets = { moderators, vips, subscribers };
    this.roleCache = { at: now, sets };
    return sets;
  }

  private roleCache?: { at: number; sets: { moderators: Set<string>; vips: Set<string>; subscribers: Set<string> } };

  private async check(label: string, fn: () => Promise<boolean>): Promise<boolean> {
    try {
      return await fn();
    } catch (err) {
      log.warn({ err, check: label }, 'relationship check failed (missing scope?) — treating as false');
      return false;
    }
  }
}
