import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { crowdHypePlugin } from './index.js';
import { EventBus } from '../../core/eventBus.js';
import { PermissionLevel, type ChatEvent, type EventUser } from '../../core/events.js';
import type { ServiceContext } from '../../core/serviceContext.js';
import { CROWD_DEFAULTS, HOLD_FOREVER, type CrowdConfig, type CrowdLive } from '../../services/crowdHype.js';

function user(overrides: Partial<EventUser> = {}): EventUser {
  return { id: 'u1', login: 'alice', displayName: 'Alice', permission: PermissionLevel.Viewer, ...overrides };
}
function chat(u = user(), emotes: { id: string; name: string; count: number }[] = [], channel = 'test'): ChatEvent {
  return { type: 'chat', channel, ts: Date.now(), message: 'hi', user: u, emotes };
}
const em = (name: string, count = 1) => ({ id: '25', name, count });

describe('crowd hype plugin', () => {
  let bus: EventBus;
  let broadcast: ReturnType<typeof vi.fn>;
  let registerFeature: ReturnType<typeof vi.fn>;
  let guestChannel: ReturnType<typeof vi.fn>;
  let touch: ReturnType<typeof vi.fn>;
  let getUsersByIds: ReturnType<typeof vi.fn>;
  let plugin: ReturnType<typeof crowdHypePlugin>;
  let config: CrowdConfig;
  let live: CrowdLive;
  let registeredCommands: string[];

  beforeEach(async () => {
    vi.useFakeTimers();
    bus = new EventBus();
    broadcast = vi.fn();
    registerFeature = vi.fn();
    guestChannel = vi.fn(() => null as string | null);
    touch = vi.fn(async () => {});
    getUsersByIds = vi.fn(async (ids: string[]) =>
      ids.map((id) => ({ id, name: id, displayName: id, profilePictureUrl: 'https://cdn/' + id + '.png' })),
    );
    registeredCommands = [];
    config = { ...CROWD_DEFAULTS, enabled: true, rows: 2, perRow: 2, rowDebounceSeconds: 0 };
    live = { mode: 'regular', pausedUntil: 0, clearedAt: 0, quiescedUntil: 0, sim: false, pausedForever: false, quiescedForever: false };

    const ctx = {
      bus,
      ws: { broadcast },
      guests: { registerFeature, guestChannel },
      users: { touch },
      storage: { prisma: { user: { findMany: async () => [] } } },
      api: { users: { getUsersByIds } },
      crowd: {
        getConfig: () => config,
        getLive: () => live,
        listImages: async () => [{ url: '/assets/crowd/a.png' }, { url: '/assets/crowd/b.png' }],
      },
      commands: { registerGroup: (name: string) => registeredCommands.push(name) },
      config: { twitch: { channel: 'test', botUsername: 'basecabot' } },
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as unknown as ServiceContext;

    plugin = crowdHypePlugin();
    await plugin.init(ctx);
    plugin.start!();
  });

  afterEach(() => {
    plugin.stop!();
    vi.useRealTimers();
  });

  /** Let a tick fire and the avatar batch settle. */
  const settle = async (ms = 700) => vi.advanceTimersByTimeAsync(ms);
  const frames = () => broadcast.mock.calls.filter((c) => c[1] === 'crowd').map((c) => c[2] as Record<string, unknown>);
  /** Spews are flushed on the first tick after a burst, so look across frames. */
  const spewsFor = (id: string) =>
    frames().flatMap((f) => ((f.spews ?? []) as { id: string; urls: string[] }[])).filter((s) => s.id === id);
  const latest = () => frames().at(-1) as { members: { id: string; row: number; avatarUrl: string | null; silhouette: string | null }[]; level: number; enabled: boolean; mode: string; quiesced: boolean; spews: { id: string; urls: string[] }[]; config: Record<string, unknown> };

  it('is a passive guest-channel feature with no commands of its own', () => {
    expect(registerFeature).toHaveBeenCalledWith({ id: 'crowd-hype', consumesRawChat: true });
    expect(registeredCommands).toEqual([]);
  });

  it('puts a chatter in the crowd and resolves their avatar', async () => {
    await bus.publish(chat());
    await settle();
    const m = latest().members;
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ id: 'u1', row: 0, avatarUrl: 'https://cdn/u1.png' });
    expect(m[0]!.silhouette).toMatch(/assets\/crowd/);
  });

  it('seats the loudest chatters in the front row', async () => {
    await bus.publish(chat(user({ id: 'loud', displayName: 'Loud' }), [em('Kappa', 9)]));
    await bus.publish(chat(user({ id: 'mid', displayName: 'Mid' }), [em('Kappa', 3)]));
    await bus.publish(chat(user({ id: 'quiet', displayName: 'Quiet' })));
    await settle();
    const rows = Object.fromEntries(latest().members.map((m) => [m.id, m.row]));
    expect(rows.loud).toBe(0);
    expect(rows.mid).toBe(0);
    expect(rows.quiet).toBe(1);
  });

  it('never puts more people on screen than the rows can hold', async () => {
    for (let i = 0; i < 20; i++) await bus.publish(chat(user({ id: 'u' + i, displayName: 'U' + i })));
    await settle();
    expect(latest().members).toHaveLength(4); // 2 rows x 2 per row
  });

  it('climbs the excitement levels as chat speeds up', async () => {
    const quiet = latest;
    await settle();
    expect(quiet().level).toBe(1);
    // 60 emote-laden messages inside the window is comfortably top level.
    for (let i = 0; i < 60; i++) await bus.publish(chat(user({ id: 'u' + (i % 4) }), [em('Kappa', 3)]));
    await settle();
    expect(latest().level).toBe(5);
  });

  it('ignores the bot itself, which is not in the audience', async () => {
    await bus.publish(chat(user({ id: 'bot', login: 'basecabot', displayName: 'BasecaBot' })));
    await settle();
    expect(latest().members).toEqual([]);
  });

  describe('guest channels', () => {
    it('follows the guest channel chat while connected to one', async () => {
      guestChannel.mockReturnValue('someoneelse');
      await bus.publish(chat(user({ id: 'guestie' }), [], 'someoneelse'));
      await bus.publish(chat(user({ id: 'homie' }), [], 'test')); // home chat is not the focus
      await settle();
      expect(latest().members.map((m) => m.id)).toEqual(['guestie']);
    });

    it('does not write guest viewers into our own user records', async () => {
      // They are somebody else's audience; their avatars are fetched but not kept.
      guestChannel.mockReturnValue('someoneelse');
      await bus.publish(chat(user({ id: 'guestie' }), [], 'someoneelse'));
      await settle();
      expect(getUsersByIds).toHaveBeenCalled();
      expect(touch).not.toHaveBeenCalled();
    });

    it('does cache avatars for our own channel', async () => {
      await bus.publish(chat());
      await settle();
      expect(touch).toHaveBeenCalledWith(expect.objectContaining({ id: 'u1', avatarUrl: 'https://cdn/u1.png' }));
    });

    it('asks Helix for a given chatter only once', async () => {
      await bus.publish(chat());
      await settle();
      await bus.publish(chat());
      await settle();
      expect(getUsersByIds).toHaveBeenCalledTimes(1);
    });
  });

  describe('emote spew', () => {
    it('forwards the emotes a chatter is spamming', async () => {
      await bus.publish(chat(user(), [em('Kappa', 3)]));
      await settle();
      const spew = spewsFor('u1');
      expect(spew).toHaveLength(1);
      expect(spew[0]!.urls).toHaveLength(3);
      expect(spew[0]!.urls[0]).toContain('static-cdn.jtvnw.net');
    });

    it('caps one chatter so a spammer cannot flood the screen', async () => {
      await bus.publish(chat(user(), [em('Kappa', 500)]));
      await settle();
      expect(spewsFor('u1')[0]!.urls.length).toBeLessThanOrEqual(6);
    });

    it('sends nothing when spew is switched off', async () => {
      config = { ...config, emoteSpew: false };
      await bus.publish(chat(user(), [em('Kappa', 3)]));
      await settle();
      expect(spewsFor('u1')).toEqual([]);
    });

    it('does not repeat a burst on the following tick', async () => {
      await bus.publish(chat(user(), [em('Kappa', 2)]));
      await settle(400);
      const first = frames().at(-1) as { spews: unknown[] };
      expect(first.spews.length).toBe(1);
      await settle(400);
      expect((frames().at(-1) as { spews: unknown[] }).spews).toEqual([]);
    });
  });

  describe('live controls', () => {
    it('draws nothing at all when disabled', async () => {
      config = { ...config, enabled: false };
      await bus.publish(chat());
      await settle();
      expect(latest()).toMatchObject({ enabled: false, members: [] });
    });

    it('empties the overlay on a clear, then holds still while paused', async () => {
      await bus.publish(chat());
      await settle();
      expect(latest().members).toHaveLength(1);

      live = { ...live, clearedAt: Date.now(), pausedUntil: Date.now() + 30_000 };
      broadcast.mockClear();
      await settle();
      expect(broadcast).toHaveBeenCalledWith('crowd', 'clear', {});
      // Paused: no roster updates at all, so the overlay simply sits there.
      expect(frames()).toEqual([]);
    });

    it('acts on a clear once, not on every tick', async () => {
      live = { ...live, clearedAt: Date.now() };
      await settle(2000);
      expect(broadcast.mock.calls.filter((c) => c[1] === 'clear')).toHaveLength(1);
    });

    it('holds the crowd at level 1 while quiesced, without clearing it', async () => {
      for (let i = 0; i < 60; i++) await bus.publish(chat(user({ id: 'u' + (i % 3) }), [em('Kappa', 3)]));
      await settle();
      expect(latest().level).toBe(5);

      live = { ...live, quiescedUntil: Date.now() + 30_000 };
      await settle();
      expect(latest()).toMatchObject({ level: 1, quiesced: true });
      expect(latest().members.length).toBeGreaterThan(0); // still on screen
    });

    it('stays cleared indefinitely until the hold is lifted', async () => {
      await bus.publish(chat());
      await settle();
      expect(latest().members).toHaveLength(1);

      live = { ...live, clearedAt: Date.now(), pausedUntil: HOLD_FOREVER, pausedForever: true };
      broadcast.mockClear();
      await settle(60_000);                 // a minute of ticks
      expect(broadcast).toHaveBeenCalledWith('crowd', 'clear', {});
      expect(frames(), 'should take no updates while held').toEqual([]);

      // ...and resuming lets it pick chat back up.
      live = { ...live, pausedUntil: 0, pausedForever: false };
      await bus.publish(chat());
      await settle();
      expect(latest().members).toHaveLength(1);
    });

    it('holds the crowd calm indefinitely while chat keeps raging', async () => {
      const rage = async () => {
        for (let i = 0; i < 60; i++) await bus.publish(chat(user({ id: 'u' + (i % 3) }), [em('Kappa', 3)]));
      };
      await rage();
      await settle();
      expect(latest().level).toBe(5);

      live = { ...live, quiescedUntil: HOLD_FOREVER, quiescedForever: true };
      await rage();
      await settle();
      // Unlike a clear, everyone stays on screen — they just settle down.
      expect(latest()).toMatchObject({ level: 1, quiesced: true });
      expect(latest().members.length).toBeGreaterThan(0);

      // A minute of unbroken spam must not shake the hold loose.
      for (let i = 0; i < 20; i++) { await rage(); await settle(3000); }
      expect(latest()).toMatchObject({ level: 1, quiesced: true });

      live = { ...live, quiescedUntil: 0, quiescedForever: false };
      await rage();
      await settle();
      expect(latest().level).toBe(5);
    });

    it('sends the calm animation values in slow mode', async () => {
      await bus.publish(chat());
      await settle();
      live = { ...live, mode: 'slow' };
      await settle();
      expect(latest().mode).toBe('slow');
      expect(latest().config.anim).toEqual(config.calm);
    });
  });

  describe('simulation', () => {
    it('invents chatters without any real chat', async () => {
      live = { ...live, sim: true };
      config = { ...config, simChatters: 8, simChatRate: 20, simEmoteRate: 20, rows: 3, perRow: 6 };
      await settle(2000);
      const m = latest().members;
      expect(m.length).toBeGreaterThan(0);
      expect(m.every((x) => x.id.startsWith('sim-'))).toBe(true);
    });

    it('never looks up an avatar for a fake chatter', async () => {
      live = { ...live, sim: true };
      config = { ...config, simChatRate: 20, simEmoteRate: 0 };
      await settle(2000);
      expect(getUsersByIds).not.toHaveBeenCalled();
      expect(touch).not.toHaveBeenCalled();
    });

    it('stops inventing once switched off', async () => {
      live = { ...live, sim: true };
      config = { ...config, simChatRate: 30, simEmoteRate: 0, rateWindowSeconds: 1 };
      await settle(1500);
      expect(latest().members.length).toBeGreaterThan(0);
      live = { ...live, sim: false };
      await settle(3000);
      expect(latest().members).toEqual([]);
    });
  });

  it('ships the current settings with every frame, so a late overlay is correct', async () => {
    await bus.publish(chat());
    await settle();
    expect(latest().config).toMatchObject({
      rows: 2, perRow: 2, rowScale: config.rowScale, glow: config.glow, emoteSpew: true,
    });
  });
});
