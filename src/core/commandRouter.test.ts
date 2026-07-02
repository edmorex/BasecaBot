import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventBus } from './eventBus.js';
import { CommandRouter } from './commandRouter.js';
import { PermissionLevel, type ChatEvent, type EventUser } from './events.js';
import type { ChatService } from '../services/chat.js';

const noopChat: ChatService = {
  say: vi.fn(async () => {}),
  reply: vi.fn(async () => {}),
  whisper: vi.fn(async () => {}),
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
});
