import { describe, it, expect, vi, beforeEach } from 'vitest';
import { firstPlugin } from './index.js';
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

describe('first plugin', () => {
  let bus: EventBus;
  let say: ReturnType<typeof vi.fn>;
  let first: {
    checkIn: ReturnType<typeof vi.fn>;
    topFirsts: ReturnType<typeof vi.fn>;
    topPoints: ReturnType<typeof vi.fn>;
    topTime: ReturnType<typeof vi.fn>;
    statsFor: ReturnType<typeof vi.fn>;
  };
  let getStreamByUserId: ReturnType<typeof vi.fn>;

  const LIVE = { startDate: new Date(Date.now() - 42_000) }; // 42s ago

  beforeEach(async () => {
    bus = new EventBus();
    say = vi.fn(async () => {});
    first = {
      checkIn: vi.fn(),
      topFirsts: vi.fn(async () => []),
      topPoints: vi.fn(async () => []),
      topTime: vi.fn(async () => []),
      statsFor: vi.fn(async () => null),
    };
    getStreamByUserId = vi.fn(async () => LIVE);

    const chatSvc = { say, reply: vi.fn(), whisper: vi.fn(), join: vi.fn(), part: vi.fn() } as unknown as ChatService;
    const commands = new CommandRouter(bus, chatSvc);
    const ctx = {
      bus,
      commands,
      chat: chatSvc,
      first,
      users: { touch: vi.fn(), resolveUserRef: vi.fn(async () => ({ kind: 'none' })) },
      api: {
        users: { getUserByName: vi.fn(async () => ({ id: 'b1' })) },
        streams: { getStreamByUserId },
      },
      config: { twitch: { broadcasterUsername: 'test' } },
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as unknown as ServiceContext;
    await firstPlugin().init(ctx);
  });

  // The router fires a group's onUnknown handler without awaiting it, so give its
  // async work (a bare "!first" check-in) a tick to settle before asserting.
  const run = async (message: string, u = user()) => {
    await bus.publish(chat(message, u));
    await new Promise((r) => setTimeout(r, 0));
  };
  const last = () => String(say.mock.calls.at(-1)?.[1] ?? '');

  it('sasses users who try to claim first before the stream is live', async () => {
    getStreamByUserId.mockResolvedValue(null);
    await run('!first');
    expect(first.checkIn).not.toHaveBeenCalled();
    expect(last()).toBe('Very naughty! You are not the first person to try and claim first before the stream has started.');
  });

  it('silently rate-limits a user spamming !first (60s cooldown)', async () => {
    first.checkIn.mockResolvedValue({ repeat: false, place: 1, timeSeconds: 42, points: 10 });
    await run('!first');
    await run('!first'); // within 60s — dropped before any work
    expect(first.checkIn).toHaveBeenCalledTimes(1);
    expect(say).toHaveBeenCalledTimes(1);

    // A different user is unaffected by someone else's cooldown.
    await run('!first', user({ id: 'u2', login: 'bob', displayName: 'Bob' }));
    expect(first.checkIn).toHaveBeenCalledTimes(2);
  });

  it('congratulates the literal FIRST', async () => {
    first.checkIn.mockResolvedValue({ repeat: false, place: 1, timeSeconds: 42, points: 10 });
    await run('!first');
    expect(last()).toBe('Congratulations Alice! You are FIRST! You clocked in at 42 seconds.');
  });

  it('needles a 2nd-placer, pluralizing correctly (1 person / was)', async () => {
    first.checkIn.mockResolvedValue({ repeat: false, place: 2, timeSeconds: 8, points: 9 });
    await run('!first');
    expect(last()).toBe(
      'Congratulations Alice! You are FIRST… if you ignore the 1 person who was FIRST before you. You clocked in at 8 seconds.',
    );
  });

  it('keeps it between us past 10th place', async () => {
    first.checkIn.mockResolvedValue({ repeat: false, place: 11, timeSeconds: 100, points: 0 });
    await run('!first');
    expect(last()).toBe(
      'Congratulations Alice! You are FIRST… if you ignore the 10 people who were FIRST before you. Let’s just keep this between us.',
    );
  });

  it('calls out a repeat claim', async () => {
    first.checkIn.mockResolvedValue({ repeat: true });
    await run('!first');
    expect(last()).toContain('already have claimed to be first');
  });

  it('passes the stream start as the race key and elapsed seconds', async () => {
    first.checkIn.mockResolvedValue({ repeat: false, place: 1, timeSeconds: 42, points: 10 });
    await run('!first');
    const [userId, streamKey, seconds] = first.checkIn.mock.calls[0]!;
    expect(userId).toBe('u1');
    expect(streamKey).toBe(LIVE.startDate.toISOString());
    expect(seconds).toBeGreaterThanOrEqual(41);
    expect(seconds).toBeLessThanOrEqual(45);
  });

  it('renders the firsts leaderboard by default', async () => {
    first.topFirsts.mockResolvedValue([
      { displayName: 'Ann', value: 3 },
      { displayName: 'Bo', value: 1 },
    ]);
    await run('!first top');
    expect(first.topFirsts).toHaveBeenCalled();
    expect(last()).toBe('🏆 Most FIRSTs: 1. Ann (3), 2. Bo (1)');
  });

  it('routes "top time" to the time board with the leaderboard alias', async () => {
    first.topTime.mockResolvedValue([{ displayName: 'Ann', value: 5.5 }]);
    await run('!first leaderboard time');
    expect(first.topTime).toHaveBeenCalled();
    expect(last()).toBe('🏆 Fastest average check-in: 1. Ann (5.5s)');
  });

  it('reports a player’s stats and ranks (self, via rank alias)', async () => {
    first.statsFor.mockResolvedValue({
      userId: 'u1',
      displayName: 'Alice',
      firsts: 2,
      topTens: 5,
      points: 30,
      avgTime: 12.34,
      avgPlace: 2.5,
      ranks: { firsts: 1, topTens: 2, points: 1, avgTime: 3, avgPlace: 4 },
    });
    await run('!first rank');
    expect(first.statsFor).toHaveBeenCalledWith('u1');
    const out = last();
    expect(out).toContain('Alice’s FIRST stats');
    expect(out).toContain('1sts: 2 (#1)');
    expect(out).toContain('avg time: 12.3s (#3)');
    expect(out).toContain('points: 30 (#1)');
  });

  it('says the user hasn’t placed when they have no stats', async () => {
    first.statsFor.mockResolvedValue(null);
    await run('!first stats');
    expect(last()).toContain('hasn’t cracked the top 10');
  });
});
