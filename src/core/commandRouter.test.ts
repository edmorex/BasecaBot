import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventBus } from './eventBus.js';
import { CommandRouter } from './commandRouter.js';
import { PermissionLevel, type ChatEvent, type CommandEvent, type EventUser } from './events.js';
import type { ChatService } from '../services/chat.js';

const noopChat: ChatService = {
  say: vi.fn(async () => {}),
  reply: vi.fn(async () => {}),
  whisper: vi.fn(async () => {}),
  join: vi.fn(async () => {}),
  part: vi.fn(),
};

function user(overrides: Partial<EventUser> = {}): EventUser {
  return { id: '1', login: 'alice', displayName: 'Alice', permission: PermissionLevel.Viewer, ...overrides };
}

function chat(message: string, u = user()): ChatEvent {
  return { type: 'chat', channel: 'test', ts: Date.now(), message, user: u };
}

describe('CommandRouter.parse', () => {
  const base = { channel: 'test', ts: 0, user: user() };

  it('returns undefined for non-commands', () => {
    expect(CommandRouter.parse('hello world', base)).toBeUndefined();
  });

  it('parses name and args', () => {
    const cmd = CommandRouter.parse('!give alice 100', base);
    expect(cmd).toMatchObject({ name: 'give', argString: 'alice 100', args: ['alice', '100'] });
  });

  it('lowercases the command name and handles no args', () => {
    const cmd = CommandRouter.parse('!POINTS', base);
    expect(cmd).toMatchObject({ name: 'points', args: [] });
  });
});

describe('CommandRouter dispatch', () => {
  let bus: EventBus;
  let router: CommandRouter;

  beforeEach(() => {
    bus = new EventBus();
    router = new CommandRouter(bus, noopChat);
  });

  it('invokes the registered handler', async () => {
    const handler = vi.fn();
    router.register('ping', handler);
    await bus.publish(chat('!ping'));
    expect(handler).toHaveBeenCalledOnce();
  });

  it('enforces permission levels', async () => {
    const handler = vi.fn();
    router.register('mod', handler, { permission: PermissionLevel.Moderator });
    await bus.publish(chat('!mod', user({ permission: PermissionLevel.Viewer })));
    expect(handler).not.toHaveBeenCalled();
    await bus.publish(chat('!mod', user({ permission: PermissionLevel.Moderator })));
    expect(handler).toHaveBeenCalledOnce();
  });

  it('honors aliases', async () => {
    const handler = vi.fn();
    router.register('points', handler, { aliases: ['p'] });
    await bus.publish(chat('!p'));
    expect(handler).toHaveBeenCalledOnce();
  });

  it('applies per-user cooldowns', async () => {
    const handler = vi.fn();
    router.register('slow', handler, { cooldownSeconds: 60 });
    await bus.publish(chat('!slow'));
    await bus.publish(chat('!slow'));
    expect(handler).toHaveBeenCalledOnce();
  });

  it('routes unknown commands to the fallback', async () => {
    const fallback = vi.fn();
    router.setFallback(fallback);
    await bus.publish(chat('!doesnotexist'));
    expect(fallback).toHaveBeenCalledOnce();
  });

  it('reports registered commands and aliases via isRegistered', () => {
    router.register('points', vi.fn(), { aliases: ['p'] });
    router.registerGroup('wheel', { subcommands: { spin: { handler: vi.fn() } } });
    expect(router.isRegistered('points')).toBe(true);
    expect(router.isRegistered('POINTS')).toBe(true); // case-insensitive
    expect(router.isRegistered('p')).toBe(true); // alias
    expect(router.isRegistered('wheel')).toBe(true); // command group
    expect(router.isRegistered('nope')).toBe(false);
  });
});

describe('CommandRouter.registerGroup', () => {
  let bus: EventBus;
  let router: CommandRouter;

  beforeEach(() => {
    bus = new EventBus();
    router = new CommandRouter(bus, noopChat);
  });

  it('dispatches to the matching subcommand with the token stripped', async () => {
    const title = vi.fn();
    router.registerGroup('wheel', { subcommands: { title: { handler: title }, spin: { handler: vi.fn() } } });
    await bus.publish(chat('!wheel title Movie Night'));
    expect(title).toHaveBeenCalledOnce();
    const e = title.mock.calls[0]![0] as CommandEvent;
    expect(e.argString).toBe('Movie Night');
    expect(e.args).toEqual(['Movie', 'Night']);
  });

  it('prints usage/description when the subcommand is missing or invalid', async () => {
    const say = vi.spyOn(noopChat, 'say');
    router.registerGroup('wheel', { description: 'Wheel help.', subcommands: { spin: { handler: vi.fn() } } });
    await bus.publish(chat('!wheel bogus'));
    expect(say).toHaveBeenCalledWith('test', 'Wheel help.');
    say.mockRestore();
  });

  it('enforces per-subcommand permission and cooldown', async () => {
    const spin = vi.fn();
    router.registerGroup('wheel', {
      subcommands: { spin: { handler: spin, permission: PermissionLevel.Moderator, cooldownSeconds: 60 } },
    });
    await bus.publish(chat('!wheel spin', user({ permission: PermissionLevel.Viewer })));
    expect(spin).not.toHaveBeenCalled(); // permission
    await bus.publish(chat('!wheel spin', user({ permission: PermissionLevel.Moderator })));
    await bus.publish(chat('!wheel spin', user({ permission: PermissionLevel.Moderator })));
    expect(spin).toHaveBeenCalledOnce(); // cooldown blocked the second
  });

  it('lists subcommands as their own entries with cooldowns', async () => {
    router.registerGroup('wheel', {
      description: 'Wheel.',
      subcommands: { add: { description: 'Add.', cooldownSeconds: 1, globalCooldownSeconds: 2, handler: vi.fn() } },
    });
    const list = router.list();
    expect(list.find((c) => c.name === 'wheel')).toMatchObject({ description: 'Wheel.' });
    expect(list.find((c) => c.name === 'wheel add')).toMatchObject({ description: 'Add.', userCooldown: 1, globalCooldown: 2 });
  });

  it('dispatches subcommand aliases to the same handler', async () => {
    const all = vi.fn();
    router.registerGroup('list', { subcommands: { all: { aliases: ['dump', 'show'], handler: all } } });
    await bus.publish(chat('!list all games'));
    await bus.publish(chat('!list dump games'));
    await bus.publish(chat('!list show games'));
    expect(all).toHaveBeenCalledTimes(3);
    expect((all.mock.calls[1]![0] as CommandEvent).argString).toBe('games'); // token stripped
  });

  it('shares one cooldown across a subcommand and its aliases', async () => {
    const all = vi.fn();
    router.registerGroup('list', {
      subcommands: { all: { aliases: ['dump'], cooldownSeconds: 60, handler: all } },
    });
    await bus.publish(chat('!list all games'));
    await bus.publish(chat('!list dump games')); // same window, via the alias
    expect(all).toHaveBeenCalledOnce();
  });

  it('lists an aliased subcommand once, under its primary name', async () => {
    router.registerGroup('list', { subcommands: { all: { aliases: ['dump', 'show'], handler: vi.fn() } } });
    const names = router.list().map((c) => c.name);
    expect(names).toContain('list all');
    expect(names).not.toContain('list dump');
    expect(names).not.toContain('list show');
  });
});
