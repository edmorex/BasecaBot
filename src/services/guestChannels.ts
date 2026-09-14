import type { ChatService } from './chat.js';
import type { TextStringsService } from './textStrings.js';
import type { AppConfig } from './config.js';
import type { Logger } from './logger.js';
import { plural } from './strings.js';

/**
 * A feature that is allowed to operate in temporary guest channels. Plugins
 * declare themselves via `ctx.guests.registerFeature(...)` in their init().
 */
export interface GuestFeature {
  /** Stable id (usually the plugin name). */
  id: string;
  /** Command names (no '!') this feature owns that may run in a guest channel. */
  ownedCommands?: string[];
  /**
   * True if this feature passively consumes ALL chat (e.g. a stats overlay), so
   * the adapter must forward every guest message, not just feature-owned commands.
   */
  consumesRawChat?: boolean;
}

/**
 * The subset of GuestChannelService the chat adapter and command router depend on
 * (injected as a policy so those modules don't take the whole service).
 */
export interface GuestPolicy {
  isGuest(channel: string): boolean;
  /** Whether a command of this name may run in `channel`. */
  commandAllowed(channel: string, name: string): boolean;
  /** Whether the adapter should forward this guest `message` onto the bus. */
  shouldForwardGuestMessage(channel: string, message: string): boolean;
}

/** Guest-connection duration bounds (seconds). */
const DEFAULT_TIMEOUT = 21600; // 6h
const MIN_TIMEOUT = 30;
const MAX_TIMEOUT = 86400; // 24h

/** Normalize a channel argument (`#Foo` / `@foo` -> `foo`); '' if implausible. */
export function normalizeChannel(raw: string): string {
  const name = raw.trim().toLowerCase().replace(/^[#@]/, '');
  return /^[a-z0-9_]{1,25}$/.test(name) ? name : '';
}

/** Clamp a requested duration (seconds) into [MIN, MAX]; default when absent/invalid. */
export function clampTimeout(raw: string | number | undefined): number {
  const n = typeof raw === 'number' ? raw : Number.parseInt(String(raw ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? Math.min(MAX_TIMEOUT, Math.max(MIN_TIMEOUT, n)) : DEFAULT_TIMEOUT;
}

/** Human-friendly duration for announcements. */
export function formatDuration(seconds: number): string {
  if (seconds % 3600 === 0) return `${seconds / 3600} ${plural(seconds / 3600, 'hour', 'hours')}`;
  if (seconds % 60 === 0) return `${seconds / 60} ${plural(seconds / 60, 'minute', 'minutes')}`;
  return `${seconds} ${plural(seconds, 'second', 'seconds')}`;
}

/**
 * Owns the bot's temporary "guest channel" connections. The bot lives in one
 * primary channel but can be invited into another with `!connect`; while there,
 * ONLY whitelisted features (registered via `registerFeature`) act — every other
 * command and all custom-command/phrase matching is suppressed (enforced by the
 * command router + chat adapter, which consult this service as a GuestPolicy).
 *
 * This service owns the mechanics: join/part (via ChatService), the auto-leave
 * timer, and the greeting/farewell announcements. The `!connect` / `!disconnect`
 * command surface lives in the guests plugin.
 */
export class GuestChannelService implements GuestPolicy {
  private readonly features: GuestFeature[] = [];
  private readonly primary: string;
  private guest: { channel: string; timer: ReturnType<typeof setTimeout> } | null = null;
  private readonly say: (channel: string, key: string, vars?: Record<string, string | number>) => Promise<void>;

  constructor(
    private readonly config: AppConfig,
    private readonly chat: ChatService,
    text: TextStringsService,
    private readonly logger: Logger,
  ) {
    this.primary = config.twitch.channel;
    const strings: Array<{ key: string; label: string; default: string; placeholders: string[] }> = [
      { key: 'greeting', label: 'Guest — greeting on join', default: "👋 BasecaBot is here! The host can use my features in this chat. (I'll auto-leave in {duration}.)", placeholders: ['duration'] },
      { key: 'departure', label: 'Guest — farewell on leave', default: '👋 BasecaBot is heading out — thanks for having me! The host can bring me back with !connect.', placeholders: [] },
    ];
    for (const s of strings) text.register({ feature: 'guest', ...s });
    this.say = text.sayer(chat, 'guest'); // blank string = silent
  }

  /** Register a feature allowed to act in guest channels. Plugins call this in init(). */
  registerFeature(feature: GuestFeature): void {
    this.features.push(feature);
    this.logger.debug({ feature: feature.id }, 'guest: feature registered');
  }

  isPrimary(channel: string): boolean {
    return channel === this.primary;
  }

  isGuest(channel: string): boolean {
    return this.guest?.channel === channel;
  }

  /** The active guest channel, or null. */
  guestChannel(): string | null {
    return this.guest?.channel ?? null;
  }

  /** Union of all registered features' owned commands (lowercased). */
  private allowedCommands(): Set<string> {
    const set = new Set<string>();
    for (const f of this.features) for (const c of f.ownedCommands ?? []) set.add(c.toLowerCase());
    return set;
  }

  private anyConsumesRawChat(): boolean {
    return this.features.some((f) => f.consumesRawChat);
  }

  /**
   * Whether a command may run in `channel`: the primary channel always; the
   * active guest only for a feature-owned command; anything else never.
   */
  commandAllowed(channel: string, name: string): boolean {
    if (this.isPrimary(channel)) return true;
    if (this.isGuest(channel)) return this.allowedCommands().has(name.toLowerCase());
    return false;
  }

  /**
   * Whether the chat adapter should forward `message` from a guest `channel`:
   * everything if a raw-chat feature is active; otherwise only feature-owned
   * commands. (Non-guest channels are handled by the adapter directly.)
   */
  shouldForwardGuestMessage(channel: string, message: string): boolean {
    if (!this.isGuest(channel)) return false;
    if (this.anyConsumesRawChat()) return true;
    const trimmed = message.trimStart();
    if (!trimmed.startsWith('!')) return false;
    const name = trimmed.slice(1).split(/\s+/, 1)[0]?.toLowerCase() ?? '';
    return this.allowedCommands().has(name);
  }

  /** Join a guest channel for `seconds`, greeting it. Returns false if the join fails. */
  async connect(channel: string, seconds: number): Promise<boolean> {
    if (this.guest) await this.disconnect(true); // one guest at a time
    try {
      await this.chat.join(channel);
    } catch (err) {
      this.logger.error({ err, channel }, 'guest: join failed');
      return false;
    }
    this.guest = { channel, timer: setTimeout(() => void this.disconnect(true), seconds * 1000) };
    await this.say(channel, 'greeting', { duration: formatDuration(seconds) }).catch(() => {});
    this.logger.info({ channel, seconds }, 'guest: connected');
    return true;
  }

  /** Leave the current guest (announcing unless silent). Returns the channel left, or null. */
  async disconnect(announce: boolean): Promise<string | null> {
    if (!this.guest) return null;
    const channel = this.guest.channel;
    clearTimeout(this.guest.timer);
    this.guest = null;
    if (announce) await this.say(channel, 'departure').catch(() => {});
    this.chat.part(channel);
    this.logger.info({ channel }, 'guest: disconnected');
    return channel;
  }

  /** Leave any guest cleanly on shutdown (no announcement). */
  async stop(): Promise<void> {
    await this.disconnect(false);
  }
}
