import { describe, it, expect, vi, beforeEach } from 'vitest';
import { eventsPlugin } from './index.js';
import { EventBus } from '../../core/eventBus.js';
import { TextStringsService } from '../../services/textStrings.js';
import type { ServiceContext } from '../../core/serviceContext.js';

/**
 * The events plugin registers its announcement strings with a REAL
 * TextStringsService (backed by a fake storage), so we can assert both the
 * registered defaults and that overriding a string changes what gets posted.
 */
describe('events plugin', () => {
  let bus: EventBus;
  let say: ReturnType<typeof vi.fn>;
  let text: TextStringsService;

  beforeEach(async () => {
    bus = new EventBus();
    say = vi.fn(async () => {});

    // Fake storage: register/get/format work purely in-memory (no overrides).
    const fakeStorage = { prisma: { textString: { findMany: async () => [], upsert: async () => {}, deleteMany: async () => {} } } } as never;
    text = new TextStringsService(fakeStorage);
    await text.init();

    const ctx = {
      bus,
      chat: { say },
      text,
      users: { touch: vi.fn(async () => {}) },
      storage: { prisma: { eventLog: { create: () => ({ catch: () => {} }) } } },
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      config: { twitch: { botUsername: 'bot' } },
    } as unknown as ServiceContext;
    await eventsPlugin().init(ctx);
  });

  const last = () => String(say.mock.calls.at(-1)?.[1] ?? '');

  it('registers the announcement strings under the "events" feature', () => {
    const groups = text.list();
    expect(groups.map((g) => g.feature)).toContain('events');
    const events = groups.find((g) => g.feature === 'events')!;
    expect(events.strings.map((s) => s.key).sort()).toEqual(['bits', 'donation', 'follow', 'live', 'raid', 'resub', 'sub', 'subgift']);
  });

  it('posts the default strings with placeholders filled in', async () => {
    await bus.publish({ type: 'live', channel: 'c', ts: 0 });
    expect(last()).toBe('😻 The stream has gone live! Who will be !first?');

    await bus.publish({ type: 'follow', channel: 'c', ts: 0, user: { id: 'u1', login: 'ann', displayName: 'Ann', permission: 0 } });
    expect(last()).toBe('👋 Thanks for the follow, @Ann!');

    await bus.publish({ type: 'raid', channel: 'c', ts: 0, fromLogin: 'Bo', viewers: 42 } as never);
    expect(last()).toBe('🚀 Bo raided with 42 viewers! Welcome!');

    await bus.publish({ type: 'resub', channel: 'c', ts: 0, user: { id: 'u1', login: 'ann', displayName: 'Ann', permission: 0 }, months: 6, tier: 1000 } as never);
    expect(last()).toBe('🎉 @Ann resubbed for 6 months!');
  });

  it('posts an overridden string once customized', async () => {
    await text.set('events', 'follow', 'NEW FOLLOWER: {user} 🎊');
    await bus.publish({ type: 'follow', channel: 'c', ts: 0, user: { id: 'u1', login: 'ann', displayName: 'Ann', permission: 0 } });
    expect(last()).toBe('NEW FOLLOWER: Ann 🎊');
  });
});
