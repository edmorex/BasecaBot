import { ChatClient, type ChatMessage } from '@twurple/chat';
import type { AuthProvider } from '@twurple/auth';
import type { EventBus } from '../../core/eventBus.js';
import type { UsersService } from '../../services/users.js';
import type { AppConfig } from '../../services/config.js';
import { PermissionLevel, type EventUser } from '../../core/events.js';
import { scopedLogger } from '../../services/logger.js';

const log = scopedLogger('chatAdapter');

/**
 * Bridges Twurple's ChatClient to the EventBus: every incoming message becomes
 * a normalized `chat` BotEvent (the CommandRouter turns command-shaped ones
 * into `command` events downstream). Also constructs the ChatClient the
 * ChatService wraps for outbound messages.
 */
export class TwitchChatAdapter {
  readonly client: ChatClient;

  constructor(
    authProvider: AuthProvider,
    private readonly bus: EventBus,
    private readonly users: UsersService,
    private readonly config: AppConfig,
  ) {
    this.client = new ChatClient({ authProvider, channels: config.twitch.channels });
  }

  async connect(): Promise<void> {
    this.client.onMessage((channel, _user, text, msg) => {
      void this.onMessage(channel, text, msg);
    });
    this.client.onConnect(() => log.info('chat connected'));
    this.client.onDisconnect((manually, reason) =>
      log.warn({ manually, reason }, 'chat disconnected'),
    );
    this.client.connect();
  }

  async disconnect(): Promise<void> {
    this.client.quit();
  }

  private async onMessage(channel: string, text: string, msg: ChatMessage): Promise<void> {
    const channelName = channel.replace(/^#/, '').toLowerCase();
    const user = this.resolveUser(msg);
    // Remember the user (fire-and-forget; don't block message handling).
    void this.users.touch(user).catch((err) => log.error({ err }, 'users.touch failed'));

    await this.bus.publish({
      type: 'chat',
      channel: channelName,
      ts: Date.now(),
      message: text,
      user,
    });
  }

  /** Map Twurple message metadata + the admin allowlist into a permission level. */
  private resolveUser(msg: ChatMessage): EventUser {
    const info = msg.userInfo;
    const login = info.userName.toLowerCase();
    let permission = PermissionLevel.Viewer;
    if (info.isSubscriber) permission = PermissionLevel.Subscriber;
    if (info.isVip) permission = PermissionLevel.Vip;
    if (info.isMod) permission = PermissionLevel.Moderator;
    if (info.isBroadcaster) permission = PermissionLevel.Broadcaster;
    if (this.config.twitch.admins.includes(login)) permission = PermissionLevel.Admin;

    return {
      id: info.userId,
      login,
      displayName: info.displayName,
      permission,
    };
  }
}
