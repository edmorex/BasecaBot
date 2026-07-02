import type { ChatClient } from '@twurple/chat';

/**
 * Outbound chat abstraction. Plugins depend on this interface, never on Twurple
 * directly — so the transport can change (or be mocked in tests) without
 * touching plugin code.
 */
export interface ChatService {
  /** Send a message to a channel. */
  say(channel: string, text: string): Promise<void>;
  /** Reply to a specific message (threaded reply where supported). */
  reply(channel: string, text: string, replyToMessageId: string): Promise<void>;
  /** Whisper a user (subject to Twitch whisper restrictions). */
  whisper(user: string, text: string): Promise<void>;
}

/** ChatService backed by a Twurple ChatClient. */
export class TwurpleChatService implements ChatService {
  constructor(private readonly client: ChatClient) {}

  async say(channel: string, text: string): Promise<void> {
    await this.client.say(channel, text);
  }

  async reply(channel: string, text: string, replyToMessageId: string): Promise<void> {
    await this.client.say(channel, text, { replyTo: replyToMessageId });
  }

  async whisper(_user: string, _text: string): Promise<void> {
    // Whispers require the Helix API + user token scopes; wired with the API adapter.
    throw new Error('whisper() not yet implemented');
  }
}
