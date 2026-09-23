import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { bossBattlePlugin } from './index.js';
import { EventBus } from '../../core/eventBus.js';
import { PermissionLevel, type ChatEvent, type EventUser } from '../../core/events.js';
import type { ServiceContext } from '../../core/serviceContext.js';
import type { ChatService } from '../../services/chat.js';
import { TextStringsService } from '../../services/textStrings.js';
import { BOSS_DEFAULTS, type BossView } from '../../services/bossBattle.js';

const BOSS: BossView = {
  id: 1,
  name: 'Dread Moth',
  description: 'It eats sweaters.',
  image: 'moth.png',
  imageUrl: '/assets/boss/moth.png',
  hp: 3,
  emotesPublic: ['Kappa'],
  emotesPrivate: ['PogChamp'],
  emotesHeal: ['HeyGuys'],
  tauntOpening: 'You cannot stop me.',
  tauntBattle: ['is that all?'],
  tauntDeath: 'impossible…',
  tauntEscape: 'another time!',
  escapeSeconds: 60,
  size: 256,
  speedFull: 9,
  speedNearDeath: 2,
  styles: ['pingpong'],
  enabled: true,
};

function user(overrides: Partial<EventUser> = {}): EventUser {
  return { id: 'u1', login: 'alice', displayName: 'Alice', permission: PermissionLevel.Viewer, ...overrides };
}
function chat(emotes: { id: string; name: string; count: number }[], u = user(), channel = 'test'): ChatEvent {
  return { type: 'chat', channel, ts: Date.now(), message: 'x', user: u, emotes };
}
const em = (name: string, count = 1) => ({ id: name, name, count });

describe('boss battle plugin', () => {
  let bus: EventBus;
  let say: ReturnType<typeof vi.fn>;
  let broadcast: ReturnType<typeof vi.fn>;
  let recordDefeat: ReturnType<typeof vi.fn>;
  let evaluate: ReturnType<typeof vi.fn>;
  let plugin: ReturnType<typeof bossBattlePlugin>;
  let starter: (bossId: number | null, delay: number) => Promise<string | null>;
  let simSpawn: (bossId: number | null) => Promise<string | null>;
  let simAct: (action: 'hit' | 'miss' | 'heal') => Promise<string | null>;
  let config: typeof BOSS_DEFAULTS;

  beforeEach(async () => {
    vi.useFakeTimers();
    bus = new EventBus();
    say = vi.fn(async () => {});
    broadcast = vi.fn();
    recordDefeat = vi.fn(async () => 1);
    evaluate = vi.fn(async () => []);
    config = { ...BOSS_DEFAULTS, cooldownSeconds: 30, alertSeconds: 1, intelSeconds: 1 };

    const chatSvc = { say, reply: vi.fn(), whisper: vi.fn(), join: vi.fn(), part: vi.fn() } as unknown as ChatService;
    const text = new TextStringsService({
      prisma: { textString: { findMany: async () => [], upsert: async () => {}, deleteMany: async () => {} } },
    } as never);
    await text.init();

    const ctx = {
      bus,
      chat: chatSvc,
      text,
      ws: { broadcast },
      achievements: { evaluate },
      users: { touch: vi.fn(async () => {}) },
      storage: { prisma: { user: { findMany: async () => [] } } },
      api: {
        users: { getUsersByIds: vi.fn(async () => []) },
        chat: { getGlobalEmotes: vi.fn(async () => []), getChannelEmotes: vi.fn(async () => []) },
      },
      stream: { broadcasterId: vi.fn(async () => 'b1') },
      boss: {
        getConfig: () => config,
        pickBoss: vi.fn(async () => BOSS),
        listSounds: vi.fn(async () => [{ slot: 'bgm', url: '/assets/boss/sfx-bgm.mp3' }]),
        recordDefeat,
        setStarter: (fn: typeof starter) => { starter = fn; },
        setCanceller: vi.fn(),
        setSimulators: (a: typeof simSpawn, b: typeof simAct) => { simSpawn = a; simAct = b; },
      },
      config: { twitch: { channel: 'test' } },
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as unknown as ServiceContext;

    plugin = bossBattlePlugin();
    await plugin.init(ctx);
    plugin.start!();
  });

  afterEach(() => {
    plugin.stop!();
    vi.useRealTimers();
  });

  /** Run a battle through alert + intel so the fight phase is live. */
  const toFight = async (start: () => Promise<string | null>) => {
    const p = start();
    await vi.advanceTimersByTimeAsync((config.alertSeconds + config.intelSeconds) * 1000 + 50);
    await p;
  };
  const sent = (type: string) => broadcast.mock.calls.filter((c) => c[1] === type).map((c) => c[2]);
  /** Advance past the frame-batching window so combat reaches the overlay. */
  const flush = async () => vi.advanceTimersByTimeAsync(150);

  it('runs the five-beat presentation in order', async () => {
    await toFight(() => starter(null, 0));
    expect(broadcast.mock.calls.map((c) => c[1])).toEqual(['alert', 'intel', 'spawn']);
    expect(sent('alert')[0]).toMatchObject({ sounds: { bgm: '/assets/boss/sfx-bgm.mp3' }, volumeSfx: 80 });
    expect(sent('intel')[0]).toMatchObject({ name: 'Dread Moth', hasSecret: true });
    // Private vulnerabilities must never be named on the intel screen.
    expect(JSON.stringify(sent('intel')[0])).not.toContain('PogChamp');
    expect(sent('spawn')[0]).toMatchObject({ hp: 3, maxHp: 3, size: 256, openingTaunt: 'You cannot stop me.' });
  });

  it('announces the warning in chat before the boss lands', async () => {
    await toFight(() => starter(null, 0));
    expect(say).toHaveBeenCalledWith('test', expect.stringContaining('A BOSS IS APPROACHING'));
  });

  it('damages the boss once per distinct vulnerable emote', async () => {
    await toFight(() => starter(null, 0));
    await bus.publish(chat([em('Kappa'), em('PogChamp')]));
    await flush();
    expect(sent('combat')[0]).toMatchObject({ hp: 1, maxHp: 3, events: [{ name: 'Alice', damage: 2, misses: 0 }] });
  });

  it('blocks a second message inside the cooldown, turning it into misses', async () => {
    await toFight(() => starter(null, 0));
    await bus.publish(chat([em('Kappa')]));
    await flush();
    await bus.publish(chat([em('Kappa')])); // same user, still cooling down
    await flush();
    const combat = sent('combat');
    expect(combat[0]).toMatchObject({ hp: 2, events: [{ damage: 1 }] });
    expect(combat[1]).toMatchObject({ hp: 2, events: [{ damage: 0, misses: 1 }] });
  });

  it('lets the cooldown expire', async () => {
    await toFight(() => starter(null, 0));
    await bus.publish(chat([em('Kappa')]));
    await flush();
    await vi.advanceTimersByTimeAsync(config.cooldownSeconds * 1000 + 100);
    await bus.publish(chat([em('Kappa')]));
    await flush();
    expect(sent('combat').at(-1)).toMatchObject({ hp: 1, events: [{ damage: 1 }] });
  });

  it('heals the boss but never above its starting health', async () => {
    await toFight(() => starter(null, 0));
    await bus.publish(chat([em('HeyGuys')])); // already at full HP
    await flush();
    expect(sent('combat')[0]).toMatchObject({ hp: 3, events: [{ heal: 1 }] });
  });

  it('credits every attacker, names the killer, and evaluates achievements', async () => {
    await toFight(() => starter(null, 0));
    const bob = user({ id: 'u2', login: 'bob', displayName: 'Bob' });
    const carol = user({ id: 'u3', login: 'carol', displayName: 'Carol' });
    await bus.publish(chat([em('Kappa')])); // Alice: 1 damage
    await bus.publish(chat([em('Kappa'), em('PogChamp')], bob)); // Bob: 2 damage -> kill
    await bus.publish(chat([em('HeyGuys')], carol)); // Carol only healed
    await flush();

    expect(sent('defeated')[0]).toMatchObject({ name: 'Dread Moth', killer: 'Bob', count: 2 });
    // Carol healed the boss — she fought for the other side and gets no credit.
    expect(recordDefeat).toHaveBeenCalledWith(['u1', 'u2'], 'u2');
    expect(evaluate.mock.calls.map((c) => c[0]).sort()).toEqual(['u1', 'u2']);
    expect(say).toHaveBeenCalledWith('test', expect.stringContaining('DEFEATED'));
  });

  it('lets the boss escape when the timer runs out', async () => {
    await toFight(() => starter(null, 0));
    await bus.publish(chat([em('Kappa')]));
    await flush();
    await vi.advanceTimersByTimeAsync(BOSS.escapeSeconds * 1000 + 100);
    expect(sent('escaped')[0]).toMatchObject({ name: 'Dread Moth', hp: 2 });
    expect(recordDefeat).not.toHaveBeenCalled();
    expect(say).toHaveBeenCalledWith('test', expect.stringContaining('ESCAPED'));
  });

  it('ignores chat from a guest channel, so a boss can only be fought at home', async () => {
    await toFight(() => starter(null, 0));
    await bus.publish(chat([em('Kappa')], user(), 'someoneelse'));
    await flush();
    expect(sent('combat')).toEqual([]);
  });

  it('ignores emotes sent before the fight phase begins', async () => {
    const p = starter(null, 0);
    await vi.advanceTimersByTimeAsync(500); // still on the red alert screen
    await bus.publish(chat([em('Kappa')]));
    await flush();
    expect(sent('combat')).toEqual([]);
    await vi.advanceTimersByTimeAsync(3000);
    await p;
  });

  it('holds a queued battle for the countdown before starting it', async () => {
    await starter(null, 15);
    await vi.advanceTimersByTimeAsync(14_000);
    expect(broadcast).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2000);
    expect(sent('alert').length).toBe(1);
  });

  it('refuses a second battle while one is already queued', async () => {
    await starter(null, 15);
    expect(await starter(null, 15)).toMatch(/already counting down/i);
  });

  it('records nothing for a simulated battle', async () => {
    await toFight(() => simSpawn(null));
    say.mockClear();
    await simAct('hit');
    await simAct('hit');
    await simAct('hit'); // 3 HP -> defeated
    await flush();
    expect(sent('defeated').length).toBe(1);
    expect(recordDefeat).not.toHaveBeenCalled();
    expect(evaluate).not.toHaveBeenCalled();
    expect(say).not.toHaveBeenCalled();
  });

  it('routes simulated misses and heals through the same combat path', async () => {
    await toFight(() => simSpawn(null));
    await simAct('miss');
    await flush();
    expect(sent('combat')[0]).toMatchObject({ hp: 3, events: [{ misses: 1, damage: 0 }] });
    await simAct('hit');
    await flush();
    await simAct('heal');
    await flush();
    expect(sent('combat').at(-1)).toMatchObject({ hp: 3, events: [{ heal: 1 }] });
  });

  it('batches a burst of chat into a single overlay frame', async () => {
    await toFight(() => starter(null, 0));
    await bus.publish(chat([em('Kappa')], user({ id: 'a', displayName: 'A' })));
    await bus.publish(chat([em('LUL')], user({ id: 'b', displayName: 'B' })));
    await bus.publish(chat([em('LUL')], user({ id: 'c', displayName: 'C' })));
    await flush();
    const frames = sent('combat');
    expect(frames.length).toBe(1); // one frame, not three messages
    expect((frames[0] as { events: unknown[] }).events.length).toBe(3);
  });

  it('ignores messages with no emotes at all', async () => {
    await toFight(() => starter(null, 0));
    await bus.publish(chat([]));
    await flush();
    expect(sent('combat')).toEqual([]);
  });
});
