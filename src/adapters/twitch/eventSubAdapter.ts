import type { ApiClient } from '@twurple/api';
import { EventSubWsListener } from '@twurple/eventsub-ws';
import type { EventBus } from '../../core/eventBus.js';
import type { AppConfig } from '../../services/config.js';
import { PermissionLevel, type EventUser } from '../../core/events.js';
import { scopedLogger } from '../../services/logger.js';

const log = scopedLogger('eventSubAdapter');

/**
 * Subscribes to Twitch EventSub (over WebSocket — no public callback needed
 * locally) and republishes subs, resubs, gift subs, bits/cheers, raids, and
 * follows as normalized BotEvents.
 *
 * Requires the appropriate scopes on the token (see .env.example). EventSub
 * subscriptions are made against the broadcaster's user id.
 */
export class TwitchEventSubAdapter {
  private listener?: EventSubWsListener;

  constructor(
    private readonly api: ApiClient,
    private readonly bus: EventBus,
    private readonly config: AppConfig,
  ) {}

  async start(): Promise<void> {
    const broadcaster = await this.api.users.getUserByName(this.config.twitch.broadcasterUsername);
    if (!broadcaster) {
      log.error({ user: this.config.twitch.broadcasterUsername }, 'broadcaster not found; EventSub disabled');
      return;
    }
    const channel = broadcaster.name.toLowerCase();
    const id = broadcaster.id;

    const listener = new EventSubWsListener({ apiClient: this.api });
    this.listener = listener;

    listener.onChannelSubscription(id, (e) =>
      this.publishUserEvent('sub', channel, {
        id: e.userId,
        login: e.userName.toLowerCase(),
        displayName: e.userDisplayName,
        permission: PermissionLevel.Subscriber,
      }, { tier: e.tier, months: 1 }),
    );

    listener.onChannelSubscriptionMessage(id, (e) =>
      this.publishUserEvent('resub', channel, {
        id: e.userId,
        login: e.userName.toLowerCase(),
        displayName: e.userDisplayName,
        permission: PermissionLevel.Subscriber,
      }, { tier: e.tier, months: e.cumulativeMonths, message: e.messageText }),
    );

    listener.onChannelSubscriptionGift(id, (e) =>
      this.bus.publish({
        type: 'subgift',
        channel,
        ts: Date.now(),
        gifter: {
          id: e.gifterId ?? '',
          login: (e.gifterName ?? 'anonymous').toLowerCase(),
          displayName: e.gifterDisplayName ?? 'Anonymous',
          permission: PermissionLevel.Viewer,
        },
        recipientLogin: '',
        tier: e.tier,
        count: e.amount,
      }),
    );

    listener.onChannelCheer(id, (e) =>
      this.bus.publish({
        type: 'bits',
        channel,
        ts: Date.now(),
        user: {
          id: e.userId ?? '',
          login: (e.userName ?? 'anonymous').toLowerCase(),
          displayName: e.userDisplayName ?? 'Anonymous',
          permission: PermissionLevel.Viewer,
        },
        amount: e.bits,
        message: e.message,
      }),
    );

    listener.onChannelRaidTo(id, (e) =>
      this.bus.publish({
        type: 'raid',
        channel,
        ts: Date.now(),
        fromLogin: e.raidingBroadcasterName.toLowerCase(),
        viewers: e.viewers,
      }),
    );

    listener.onChannelFollow(id, id, (e) =>
      this.publishUserEvent('follow', channel, {
        id: e.userId,
        login: e.userName.toLowerCase(),
        displayName: e.userDisplayName,
        permission: PermissionLevel.Viewer,
      }),
    );

    listener.start();
    log.info({ channel }, 'EventSub listening');
  }

  async stop(): Promise<void> {
    this.listener?.stop();
  }

  private publishUserEvent(
    type: 'sub' | 'resub' | 'follow',
    channel: string,
    user: EventUser,
    extra: { tier?: string; months?: number; message?: string } = {},
  ): void {
    if (type === 'follow') {
      void this.bus.publish({ type, channel, ts: Date.now(), user });
      return;
    }
    void this.bus.publish({
      type,
      channel,
      ts: Date.now(),
      user,
      tier: extra.tier ?? '1000',
      months: extra.months ?? 1,
      message: extra.message,
    });
  }
}
