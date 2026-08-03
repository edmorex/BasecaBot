import type { ApiClient } from '@twurple/api';
import type { Logger } from './logger.js';
import { humanDuration } from './strings.js';

interface Cached<T> {
  at: number;
  value: T;
}

/**
 * One cached view of the broadcaster's Twitch state — id, live stream, and
 * channel info (game/title). Plugins that need "is the channel live?", the
 * stream start time, the broadcaster id, or the current game share this instead
 * of each re-implementing the Helix lookup + caching (which they all used to).
 *
 * All reads are cached briefly and swallow API errors (returning the last-known
 * value, or null), so a transient Helix hiccup never throws into a command.
 */
export class StreamService {
  private bcast: { id: string; login: string; displayName: string } | null | undefined; // undefined = not resolved
  private streamC?: Cached<{ viewers: number; startDate: Date } | null>;
  private infoC?: Cached<{ gameName: string; title: string; displayName: string } | null>;

  private static readonly STREAM_TTL = 10_000;
  private static readonly INFO_TTL = 15_000;

  constructor(
    private readonly api: ApiClient,
    private readonly broadcasterUsername: string,
    private readonly logger: Logger,
  ) {}

  private fresh<T>(c: Cached<T> | undefined, ttl: number): c is Cached<T> {
    return !!c && Date.now() - c.at < ttl;
  }

  /** The broadcaster's { id, login, displayName }, resolved once and cached. */
  async broadcaster(): Promise<{ id: string; login: string; displayName: string } | null> {
    if (this.bcast !== undefined) return this.bcast;
    try {
      const u = await this.api.users.getUserByName(this.broadcasterUsername);
      this.bcast = u ? { id: u.id, login: u.name, displayName: u.displayName } : null;
    } catch (err) {
      this.logger.warn({ err }, 'stream: broadcaster lookup failed');
      this.bcast = null;
    }
    return this.bcast;
  }

  /** The broadcaster's Twitch user id, or null. */
  async broadcasterId(): Promise<string | null> {
    return (await this.broadcaster())?.id ?? null;
  }

  /**
   * The live stream (viewers + start time), or null when offline. Cached; on an
   * API error keeps the last-known value so callers don't see spurious offline.
   */
  async stream(): Promise<{ viewers: number; startDate: Date } | null> {
    let value = this.streamC?.value ?? null; // last-known, kept on API error
    if (this.fresh(this.streamC, StreamService.STREAM_TTL)) return this.streamC.value;
    try {
      const id = await this.broadcasterId();
      const s = id ? await this.api.streams.getStreamByUserId(id) : null;
      value = s ? { viewers: s.viewers, startDate: s.startDate } : null;
    } catch (err) {
      this.logger.warn({ err }, 'stream: live check failed; using last-known state');
    }
    this.streamC = { at: Date.now(), value };
    return value;
  }

  /** Whether the channel is currently live. */
  async isLive(): Promise<boolean> {
    return (await this.stream()) !== null;
  }

  /** Channel info (game / title / display name), or null. Cached. */
  async info(): Promise<{ gameName: string; title: string; displayName: string } | null> {
    let value = this.infoC?.value ?? null; // last-known, kept on API error
    if (this.fresh(this.infoC, StreamService.INFO_TTL)) return this.infoC.value;
    try {
      const id = await this.broadcasterId();
      const c = id ? await this.api.channels.getChannelInfoById(id) : null;
      value = c ? { gameName: c.gameName, title: c.title, displayName: c.displayName } : null;
    } catch (err) {
      this.logger.warn({ err }, 'stream: channel info fetch failed');
    }
    this.infoC = { at: Date.now(), value };
    return value;
  }

  /** The current game/category (trimmed), or null if none/unknown. */
  async game(): Promise<string | null> {
    const g = (await this.info())?.gameName?.trim();
    return g || null;
  }

  /** Uptime as a human string (e.g. "2 hours 15 minutes"), or null when offline. */
  async uptime(): Promise<string | null> {
    const s = await this.stream();
    return s ? humanDuration(Date.now() - s.startDate.getTime()) : null;
  }
}
