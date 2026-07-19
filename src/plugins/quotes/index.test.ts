import { describe, it, expect, vi, beforeEach } from 'vitest';
import { quotesPlugin } from './index.js';
import { EventBus } from '../../core/eventBus.js';
import { CommandRouter } from '../../core/commandRouter.js';
import { PermissionLevel, type ChatEvent, type EventUser } from '../../core/events.js';
import type { ServiceContext } from '../../core/serviceContext.js';
import type { ChatService } from '../../services/chat.js';

function user(overrides: Partial<EventUser> = {}): EventUser {
  return { id: 'u1', login: 'alice', displayName: 'Alice', permission: PermissionLevel.Viewer, ...overrides };
}

function chat(message: string, u = user()): ChatEvent {
  return { type: 'chat', channel: 'test', ts: Date.now(), message, user: u };
}

describe('quotes plugin — help', () => {
  let bus: EventBus;
  let say: ReturnType<typeof vi.fn>;
  let random: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    bus = new EventBus();
    say = vi.fn(async () => {});
    random = vi.fn(async () => null);

    const chatSvc = { say, reply: vi.fn(), whisper: vi.fn(), join: vi.fn(), part: vi.fn() } as unknown as ChatService;
    const commands = new CommandRouter(bus, chatSvc);
    const ctx = {
      bus,
      commands,
      chat: chatSvc,
      quotes: { random },
      users: { touch: vi.fn() },
      api: { users: { getUserByName: vi.fn() }, channels: { getChannelInfoById: vi.fn() } },
      config: { twitch: { broadcasterUsername: 'test' } },
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as unknown as ServiceContext;
    await quotesPlugin().init(ctx);
  });

  const said = () => say.mock.calls.map((c) => String(c[1])).join('\n');

  it('prints usage for the basic commands and links to the dashboard', async () => {
    await bus.publish(chat('!quote help'));
    const out = said();
    expect(out).toContain('!quote'); // random (no arg)
    expect(out).toContain('!quote <id>'); // specific
    expect(out).toContain('!quote add'); // add
    expect(out).toContain('https://bot.edmorex.com/quotes'); // see them all
  });

  // `help` is a real subcommand, so it must not fall through to the random-quote
  // handler and print an actual quote.
  it('does not emit a random quote', async () => {
    await bus.publish(chat('!quote help'));
    expect(random).not.toHaveBeenCalled();
  });
});
