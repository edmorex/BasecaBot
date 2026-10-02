import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { floofPlugin } from './index.js';
import { EventBus } from '../../core/eventBus.js';
import { CommandRouter } from '../../core/commandRouter.js';
import { PermissionLevel, type ChatEvent, type EventUser } from '../../core/events.js';
import type { ServiceContext } from '../../core/serviceContext.js';
import type { ChatService } from '../../services/chat.js';
import { TextStringsService } from '../../services/textStrings.js';
import { FLOOF_DEFAULTS, FloofError, DEFAULT_FLOOF_NAME, type FloofStyle } from '../../services/floof.js';

const IMAGE = {
  name: 'mochi.png', url: '/assets/floofs/mochi.png', bytes: 1,
  styles: ['pingpong'] as FloofStyle[], taunts: ['!pet me'],
  label: 'Mochi', displayName: 'Mochi',
};
/** The same photo, never named — the game should fall back to the stand-in. */
const UNNAMED = { ...IMAGE, label: '', displayName: DEFAULT_FLOOF_NAME };

function user(overrides: Partial<EventUser> = {}): EventUser {
  return { id: 'u1', login: 'alice', displayName: 'Alice', permission: PermissionLevel.Viewer, ...overrides };
}
function chat(message: string, u = user()): ChatEvent {
  return { type: 'chat', channel: 'test', ts: Date.now(), message, user: u };
}

describe('floof plugin', () => {
  let bus: EventBus;
  let say: ReturnType<typeof vi.fn>;
  let broadcast: ReturnType<typeof vi.fn>;
  let recordWin: ReturnType<typeof vi.fn>;
  let pickSpawn: ReturnType<typeof vi.fn>;
  let isLive: ReturnType<typeof vi.fn>;
  let plugin: ReturnType<typeof floofPlugin>;
  let spawner: (image: string | null, style: FloofStyle | null) => Promise<string | null>;
  let simulatePet: () => Promise<string | null>;

  beforeEach(async () => {
    vi.useFakeTimers();
    bus = new EventBus();
    say = vi.fn(async () => {});
    broadcast = vi.fn();
    recordWin = vi.fn(async () => 1);
    pickSpawn = vi.fn(async () => ({ image: IMAGE, style: 'pingpong' as FloofStyle }));
    isLive = vi.fn(async () => true);

    const chatSvc = { say, reply: vi.fn(), whisper: vi.fn(), join: vi.fn(), part: vi.fn() } as unknown as ChatService;
    const commands = new CommandRouter(bus, chatSvc);
    const text = new TextStringsService({
      prisma: { textString: { findMany: async () => [], upsert: async () => {}, deleteMany: async () => {} } },
    } as never);
    await text.init();

    const ctx = {
      bus,
      commands,
      chat: chatSvc,
      text,
      ws: { broadcast },
      achievements: { evaluate: vi.fn(async () => []) },
      users: { touch: vi.fn(async () => {}), resolveUserRef: vi.fn(async () => ({ kind: 'none' })) },
      stream: { isLive },
      floof: {
        getConfig: () => ({ ...FLOOF_DEFAULTS, enabled: true }),
        pickSpawn,
        recordWin,
        statsFor: vi.fn(async () => ({ wins: 0, rank: null, lastWonAt: null })),
        setSpawner: (fn: typeof spawner) => { spawner = fn; },
        setPetSimulator: (fn: typeof simulatePet) => { simulatePet = fn; },
      },
      config: { twitch: { channel: 'test' } },
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as unknown as ServiceContext;

    plugin = floofPlugin();
    await plugin.init(ctx);
    plugin.start!();
  });

  afterEach(() => {
    plugin.stop!();
    vi.useRealTimers();
  });

  // onUnknown is fired without being awaited, so let its async work settle.
  const pet = async (u = user()) => {
    await bus.publish(chat('!pet', u));
    await vi.advanceTimersByTimeAsync(0);
  };
  const said = () => say.mock.calls.map((c) => String(c[1]));
  const last = () => said().at(-1) ?? '';

  it('announces the winner by the floof’s name and records the win', async () => {
    await spawner(null, null);
    await pet();
    expect(recordWin).toHaveBeenCalledWith('u1');
    expect(last()).toBe('🐾 Mochi got a pet from Alice! That is 1 floof pet for them.');
    expect(broadcast).toHaveBeenCalledWith('floof', 'pet', { user: 'Alice' });
  });

  it('calls an unnamed floof "The floof" rather than leaving a gap', async () => {
    pickSpawn.mockResolvedValue({ image: UNNAMED, style: 'pingpong' as FloofStyle });
    await spawner(null, null);
    await pet();
    expect(last()).toBe('🐾 The floof got a pet from Alice! That is 1 floof pet for them.');
  });

  it('names the floof that was actually on screen, not whichever is current', async () => {
    // The round captures its own name, so a spawn landing between the win and the
    // announcement cannot put the wrong floof in the message.
    pickSpawn.mockResolvedValue({ image: { ...IMAGE, label: 'Biscuit', displayName: 'Biscuit' }, style: 'pingpong' as FloofStyle });
    await spawner(null, null);
    pickSpawn.mockResolvedValue({ image: IMAGE, style: 'pingpong' as FloofStyle });
    await pet();
    expect(last()).toContain('Biscuit got a pet from Alice');
  });

  it('tells a chatter there is no floof when none is out', async () => {
    await pet();
    expect(last()).toContain('no floof to pet');
  });

  describe('post-win quiet period', () => {
    const bob = user({ id: 'u2', login: 'bob', displayName: 'Bob' });
    const carol = user({ id: 'u3', login: 'carol', displayName: 'Carol' });

    it('stays silent for stragglers right after someone wins', async () => {
      await spawner(null, null);
      await pet();                       // Alice wins
      say.mockClear();
      await pet(bob);                    // ...and chat is still typing
      await pet(carol);
      expect(say).not.toHaveBeenCalled();
    });

    it('stays silent for the whole 15 seconds', async () => {
      await spawner(null, null);
      await pet();
      say.mockClear();
      await vi.advanceTimersByTimeAsync(14_900);
      await pet(bob);
      expect(say).not.toHaveBeenCalled();
    });

    it('speaks again once the window has passed', async () => {
      await spawner(null, null);
      await pet();
      say.mockClear();
      await vi.advanceTimersByTimeAsync(15_100);
      await pet(bob);
      expect(last()).toContain('no floof to pet');
    });

    it('does not burn the suppressed chatter’s own rate limit', async () => {
      // A straggler silenced by the quiet period must still be able to ask once
      // it lifts, rather than being locked out for the idle cooldown as well.
      await spawner(null, null);
      await pet();
      await pet(bob);                    // suppressed
      say.mockClear();
      await vi.advanceTimersByTimeAsync(15_100);
      await pet(bob);
      expect(last()).toContain('no floof to pet');
    });

    it('applies after a simulated win too, since the overlay played one', async () => {
      await spawner(null, null);
      await simulatePet();
      say.mockClear();
      await pet(bob);
      expect(say).not.toHaveBeenCalled();
    });

    it('does NOT apply when the floof simply despawned unclaimed', async () => {
      await spawner(null, null);
      await vi.advanceTimersByTimeAsync(FLOOF_DEFAULTS.despawnSeconds * 1000 + 100);
      expect(broadcast).toHaveBeenCalledWith('floof', 'despawn', {});
      await pet(bob);
      expect(last()).toContain('no floof to pet');
    });

    it('never suppresses an actual win', async () => {
      await spawner(null, null);
      await pet();                       // sets the quiet window
      await spawner(null, null);          // a new floof lands inside it
      say.mockClear();
      await pet(bob);
      expect(last()).toContain('got a pet from Bob');
    });
  });

  it('rate-limits a chatter spamming !pet with no floof out', async () => {
    await pet();
    expect(say).toHaveBeenCalledTimes(1);
    await pet();                         // same user, inside the idle cooldown
    expect(say).toHaveBeenCalledTimes(1);
    // A different chatter is unaffected by someone else's cooldown.
    await pet(user({ id: 'u9', login: 'dave', displayName: 'Dave' }));
    expect(say).toHaveBeenCalledTimes(2);
  });

  it('only lets the first !pet win', async () => {
    await spawner(null, null);
    await pet();
    await pet(user({ id: 'u2', login: 'bob', displayName: 'Bob' }));
    expect(recordWin).toHaveBeenCalledTimes(1);
  });

  it('passes an explicit photo and style through to the picker', async () => {
    await spawner('biscuit.png', 'ghost');
    expect(pickSpawn).toHaveBeenCalledWith('biscuit.png', 'ghost');
  });

  it('surfaces the picker’s complaint rather than spawning nothing', async () => {
    pickSpawn.mockRejectedValue(new FloofError('No floof photos have been uploaded yet.'));
    expect(await spawner(null, null)).toMatch(/no floof photos/i);
  });

  it('reports when there is nothing to simulate', async () => {
    expect(await simulatePet()).toMatch(/no floof on screen/i);
  });
});
