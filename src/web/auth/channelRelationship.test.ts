import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ApiClient } from '@twurple/api';
import { ChannelRelationshipService } from './channelRelationship.js';
import type { AppConfig } from '../../services/config.js';
import type { SessionUser } from './types.js';

const BROADCASTER_ID = 'bc-1';

function makeApi() {
  return {
    moderation: { checkUserMod: vi.fn() },
    subscriptions: { getSubscriptionForUser: vi.fn() },
    channels: { getChannelFollowers: vi.fn() },
  } as unknown as ApiClient & {
    moderation: { checkUserMod: ReturnType<typeof vi.fn> };
    subscriptions: { getSubscriptionForUser: ReturnType<typeof vi.fn> };
    channels: { getChannelFollowers: ReturnType<typeof vi.fn> };
  };
}

function configWithAdmins(admins: string[]): AppConfig {
  return { twitch: { admins } } as unknown as AppConfig;
}

function user(overrides: Partial<SessionUser> = {}): SessionUser {
  return { id: 'u-1', login: 'alice', displayName: 'Alice', avatar: '', ...overrides };
}

describe('ChannelRelationshipService', () => {
  let api: ReturnType<typeof makeApi>;

  beforeEach(() => {
    api = makeApi();
  });

  it('short-circuits the broadcaster to all-true without API calls', async () => {
    const svc = new ChannelRelationshipService(api, configWithAdmins([]), BROADCASTER_ID);
    const rel = await svc.compute(user({ id: BROADCASTER_ID }));
    expect(rel).toEqual({ broadcaster: true, botAdmin: true, moderator: true, subscriber: true, follower: true });
    expect(api.moderation.checkUserMod).not.toHaveBeenCalled();
  });

  it('computes mod/sub/follower from Helix and admin from config', async () => {
    api.moderation.checkUserMod.mockResolvedValue(true);
    api.subscriptions.getSubscriptionForUser.mockResolvedValue({ tier: '1000' });
    api.channels.getChannelFollowers.mockResolvedValue({ data: [{ userId: 'u-1' }] });

    const svc = new ChannelRelationshipService(api, configWithAdmins(['alice']), BROADCASTER_ID);
    const rel = await svc.compute(user());
    expect(rel).toEqual({ broadcaster: false, botAdmin: true, moderator: true, subscriber: true, follower: true });
  });

  it('treats not-subscribed / not-following / not-mod as false', async () => {
    api.moderation.checkUserMod.mockResolvedValue(false);
    api.subscriptions.getSubscriptionForUser.mockResolvedValue(null);
    api.channels.getChannelFollowers.mockResolvedValue({ data: [] });

    const svc = new ChannelRelationshipService(api, configWithAdmins([]), BROADCASTER_ID);
    const rel = await svc.compute(user());
    expect(rel).toEqual({ broadcaster: false, botAdmin: false, moderator: false, subscriber: false, follower: false });
  });

  it('degrades a failing check to false (e.g. missing scope)', async () => {
    api.moderation.checkUserMod.mockRejectedValue(new Error('missing scope moderation:read'));
    api.subscriptions.getSubscriptionForUser.mockResolvedValue(null);
    api.channels.getChannelFollowers.mockResolvedValue({ data: [] });

    const svc = new ChannelRelationshipService(api, configWithAdmins([]), BROADCASTER_ID);
    const rel = await svc.compute(user());
    expect(rel.moderator).toBe(false);
  });
});
