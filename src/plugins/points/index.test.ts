import { describe, it, expect, vi, beforeEach } from 'vitest';
import { pointsPlugin } from './index.js';
import { EventBus } from '../../core/eventBus.js';
import { CommandRouter } from '../../core/commandRouter.js';
import { PermissionLevel, type ChatEvent, type EventUser } from '../../core/events.js';
import type { ServiceContext } from '../../core/serviceContext.js';
import type { ChatService } from '../../services/chat.js';
import { InsufficientPointsError } from '../../services/points.js';

function user(overrides: Partial<EventUser> = {}): EventUser {
  return { id: 'u1', login: 'alice', displayName: 'Alice', permission: PermissionLevel.Viewer, ...overrides };
}

function chat(message: string, u = user()): ChatEvent {
  return { type: 'chat', channel: 'test', ts: Date.now(), message, user: u };
}

const sub = (o: Partial<EventUser> = {}) => user({ permission: PermissionLevel.Subscriber, ...o });
const broadcaster = (o: Partial<EventUser> = {}) => user({ permission: PermissionLevel.Broadcaster, ...o });

describe('points plugin commands', () => {
  let bus: EventBus;
  let say: ReturnType<typeof vi.fn>;
  let getBalance: ReturnType<typeof vi.fn>;
  let transfer: ReturnType<typeof vi.fn>;
  let award: ReturnType<typeof vi.fn>;
  let resolveUserRef: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    bus = new EventBus();
    say = vi.fn(async () => {});
    getBalance = vi.fn(async () => 120);
    transfer = vi.fn(async () => {});
    award = vi.fn(async () => 500);
    resolveUserRef = vi.fn(async (name: string) =>
      name.replace(/^@/, '').toLowerCase() === 'bob'
        ? { kind: 'user', id: 'u2', login: 'bob', displayName: 'Bob' }
        : { kind: 'unlinked', name },
    );

    const chatSvc = { say, reply: vi.fn(), whisper: vi.fn(), join: vi.fn(), part: vi.fn() } as unknown as ChatService;
    const commands = new CommandRouter(bus, chatSvc);
    const ctx = {
      bus,
      commands,
      chat: chatSvc,
      points: { getBalance, transfer, award },
      users: { resolveUserRef },
      api: { users: { getUserByName: vi.fn() } },
      config: { twitch: { channel: 'test', broadcasterUsername: 'test', botUsername: 'bot', admins: [] }, points: { name: 'points' } },
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as unknown as ServiceContext;
    await pointsPlugin().init(ctx);
  });

  const said = () => say.mock.calls.map((c) => String(c[1])).join('\n');

  it('reports your own balance for bare !points and the !p alias', async () => {
    await bus.publish(chat('!points'));
    expect(say).toHaveBeenCalledWith('test', '@Alice you have 120 points.');

    say.mockClear();
    await bus.publish(chat('!p'));
    expect(say).toHaveBeenCalledWith('test', '@Alice you have 120 points.');
  });

  // The leaderboard was removed deliberately — balances are private. `!points top`
  // must not expose anyone else's total; it falls through to the caller's own.
  it('no longer exposes a leaderboard via !points top', async () => {
    await bus.publish(chat('!points top'));
    expect(said()).toBe('@Alice you have 120 points.');
    expect(said()).not.toMatch(/top|leaderboard/i);
  });

  describe('!points give', () => {
    it('is refused below subscriber', async () => {
      await bus.publish(chat('!points give bob 10'));
      expect(transfer).not.toHaveBeenCalled();
    });

    it('transfers for a subscriber, resolving the target by any name', async () => {
      await bus.publish(chat('!points give @BOB 10', sub()));
      expect(resolveUserRef).toHaveBeenCalledWith('@BOB');
      expect(transfer).toHaveBeenCalledWith('u1', 'u2', 10);
      expect(said()).toBe('@Alice gave 10 points to Bob.');
    });

    // A distinct caller per case: `give` has a 3s per-user cooldown, so firing
    // them all as one user would silently drop everything after the first.
    it('rejects a non-positive or non-numeric amount', async () => {
      const cases = ['!points give bob 0', '!points give bob -5', '!points give bob lots', '!points give bob'];
      for (const [i, msg] of cases.entries()) {
        say.mockClear();
        await bus.publish(chat(msg, sub({ id: `caller${i}` })));
        expect(said(), msg).toBe('Usage: !points give <user> <amount>');
      }
      expect(transfer).not.toHaveBeenCalled();
    });

    it('applies a per-user cooldown', async () => {
      await bus.publish(chat('!points give bob 10', sub()));
      await bus.publish(chat('!points give bob 10', sub()));
      expect(transfer).toHaveBeenCalledTimes(1); // second call inside the 3s window
    });

    it('explains an unknown recipient instead of transferring', async () => {
      await bus.publish(chat('!points give nobody 10', sub()));
      expect(transfer).not.toHaveBeenCalled();
      expect(said()).toBe("I don't know a user called nobody.");
    });

    it('reports insufficient funds rather than throwing', async () => {
      transfer.mockRejectedValueOnce(new InsufficientPointsError(3, 10));
      await bus.publish(chat('!points give bob 10', sub()));
      expect(said()).toBe('@Alice you only have 3 points.');
    });
  });

  describe('!points grant', () => {
    it('is refused below broadcaster — including for a subscriber', async () => {
      await bus.publish(chat('!points grant bob 100', sub()));
      expect(award).not.toHaveBeenCalled();
    });

    it('awards for the broadcaster', async () => {
      await bus.publish(chat('!points grant bob 100', broadcaster()));
      expect(award).toHaveBeenCalledWith('u2', 100);
      expect(said()).toBe('Bob now has 500 points.');
    });

    // Unlike `give`, a negative amount is meaningful here: it deducts.
    it('accepts a negative amount', async () => {
      await bus.publish(chat('!points grant bob -50', broadcaster()));
      expect(award).toHaveBeenCalledWith('u2', -50);
    });

    it('rejects zero and non-numeric amounts', async () => {
      for (const [i, msg] of ['!points grant bob 0', '!points grant bob heaps'].entries()) {
        say.mockClear();
        await bus.publish(chat(msg, broadcaster({ id: `bc${i}` })));
        expect(said()).toBe('Usage: !points grant <user> <amount>');
      }
      expect(award).not.toHaveBeenCalled();
    });
  });

  // The old top-level commands are gone; they must not still be dispatchable.
  it('no longer registers !give or !addpoints', async () => {
    await bus.publish(chat('!give bob 10', sub()));
    await bus.publish(chat('!addpoints bob 10', broadcaster()));
    expect(transfer).not.toHaveBeenCalled();
    expect(award).not.toHaveBeenCalled();
  });
});
