import { ChatClient, type ChatMessage } from '@twurple/chat';
import type { AuthProvider } from '@twurple/auth';
import type { EventBus } from '../../core/eventBus.js';
import type { UsersService } from '../../services/users.js';
import type { AppConfig } from '../../services/config.js';
import { PermissionLevel, type EventUser } from '../../core/events.js';
import type { GuestPolicy } from '../../services/guestChannels.js';
import { scopedLogger } from '../../services/logger.js';

const log = scopedLogger('chatAdapter');

/**
 * Extract Twitch-native emotes from a message's IRC tags. `emoteOffsets` maps an
 * emote id to its character ranges ("start-end"); the count is how many ranges,
 * and the name is the message text at the first range. Third-party emotes
 * (BTTV/FFZ/7TV) aren't in the tags and aren't captured.
 */
function extractEmotes(text: string, msg: ChatMessage): { id: string; name: string; count: number }[] {
  const offsets = msg.emoteOffsets;
  if (!offsets || offsets.size === 0) return [];
  const chars = [...text]; // code-point aware, matching Twitch's offset indexing
  const out: { id: string; name: string; count: number }[] = [];
  for (const [id, ranges] of offsets) {
    let name = id;
    const parts = ranges[0]?.split('-');
    if (parts && parts.length === 2) {
      const a = Number(parts[0]);
      const b = Number(parts[1]);
      if (Number.isInteger(a) && Number.isInteger(b) && a >= 0 && b < chars.length) name = chars.slice(a, b + 1).join('');
    }
    out.push({ id, name, count: ranges.length });
  }
  return out;
}

/**
 * Bridges Twurple's ChatClient to the EventBus: every incoming message becomes
 * a normalized `chat` BotEvent (the CommandRouter turns command-shaped ones
 * into `command` events downstream). Also constructs the ChatClient the
 * ChatService wraps for outbound messages.
 *
 * The bot operates in ONE primary channel (the broadcaster's). It may join
 * temporary "guest" channels; in those, the injected GuestPolicy decides which
 * messages are forwarded (only whitelisted features act there), and guest users
 * are never persisted.
 */
export class TwitchChatAdapter {
  readonly client: ChatClient;
  private guests?: GuestPolicy;

  constructor(
    authProvider: AuthProvider,
    private readonly bus: EventBus,
    private readonly users: UsersService,
    private readonly config: AppConfig,
  ) {
    this.client = new ChatClient({ authProvider, channels: [config.twitch.channel] });
  }

  /** Wire the guest-channel policy (set before connect()). */
  setGuestPolicy(guests: GuestPolicy): void {
    this.guests = guests;
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
    const isPrimary = channelName === this.config.twitch.channel;
    // In a guest channel, forward only what the guest policy allows (feature-owned
    // commands, or all chat when a raw-chat feature is active). Guest users are
    // never persisted (guest chat is not tracked).
    if (!isPrimary && !this.guests?.shouldForwardGuestMessage(channelName, text)) return;

    const user = this.resolveUser(msg);
    if (isPrimary) {
      // Remember the user (fire-and-forget; don't block message handling).
      void this.users.touch(user).catch((err) => log.error({ err }, 'users.touch failed'));
    }

    await this.bus.publish({
      type: 'chat',
      channel: channelName,
      ts: Date.now(),
      message: text,
      user,
      emotes: extractEmotes(text, msg),
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
