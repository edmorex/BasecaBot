import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GuestChannelService, normalizeChannel, clampTimeout, formatDuration } from './guestChannels.js';
import { TextStringsService } from './textStrings.js';
import type { ChatService } from './chat.js';
import type { AppConfig } from './config.js';
import type { Logger } from './logger.js';

function make() {
  const say = vi.fn(async () => {});
  const join = vi.fn(async () => {});
  const part = vi.fn();
  const chat = { say, reply: vi.fn(), whisper: vi.fn(), join, part } as unknown as ChatService;
  const text = new TextStringsService({ prisma: { textString: { findMany: async () => [] } } } as never);
  const config = { twitch: { channel: 'primary' } } as unknown as AppConfig;
  const noop = () => {};
  const logger = { info: noop, warn: noop, error: noop, debug: noop, child: () => logger } as unknown as Logger;
  return { svc: new GuestChannelService(config, chat, text, logger), say, join, part };
}

describe('guestChannels helpers', () => {
  it('normalizes channel names and rejects junk', () => {
    expect(normalizeChannel('#Foo')).toBe('foo');
    expect(normalizeChannel('@Bar_1')).toBe('bar_1');
    expect(normalizeChannel('has space')).toBe('');
    expect(normalizeChannel('')).toBe('');
  });

  it('clamps durations into [30, 86400] with a 6h default', () => {
    expect(clampTimeout('60')).toBe(60);
    expect(clampTimeout('5')).toBe(30); // below min
    expect(clampTimeout('999999')).toBe(86400); // above max
    expect(clampTimeout('')).toBe(21600); // default
    expect(clampTimeout(undefined)).toBe(21600);
  });

  it('formats durations', () => {
    expect(formatDuration(3600)).toBe('1 hour');
    expect(formatDuration(120)).toBe('2 minutes');
    expect(formatDuration(45)).toBe('45 seconds');
  });
});

describe('GuestChannelService policy', () => {
  it('allows all commands on the primary; only owned commands in the active guest', async () => {
    const { svc } = make();
    svc.registerFeature({ id: 'wheel', ownedCommands: ['wheel'] });
    await svc.connect('guestchan', 60);

    expect(svc.commandAllowed('primary', 'points')).toBe(true); // primary: anything
    expect(svc.commandAllowed('guestchan', 'wheel')).toBe(true); // owned
    expect(svc.commandAllowed('guestchan', 'WHEEL')).toBe(true); // case-insensitive
    expect(svc.commandAllowed('guestchan', 'points')).toBe(false); // not owned
    expect(svc.commandAllowed('elsewhere', 'wheel')).toBe(false); // not primary, not the guest
  });

  it('forwards only owned commands when no raw-chat feature is registered', async () => {
    const { svc } = make();
    svc.registerFeature({ id: 'wheel', ownedCommands: ['wheel'] });
    await svc.connect('guestchan', 60);
    expect(svc.shouldForwardGuestMessage('guestchan', '!wheel spin')).toBe(true);
    expect(svc.shouldForwardGuestMessage('guestchan', 'just chatting')).toBe(false);
    expect(svc.shouldForwardGuestMessage('guestchan', '!points')).toBe(false);
    expect(svc.shouldForwardGuestMessage('other', '!wheel spin')).toBe(false); // not the guest
  });

  it('forwards ALL guest chat once a raw-chat feature is registered', async () => {
    const { svc } = make();
    svc.registerFeature({ id: 'wheel', ownedCommands: ['wheel'] });
    svc.registerFeature({ id: 'chat-stats', consumesRawChat: true });
    await svc.connect('guestchan', 60);
    expect(svc.shouldForwardGuestMessage('guestchan', 'just chatting')).toBe(true);
    expect(svc.shouldForwardGuestMessage('guestchan', '!points')).toBe(true);
    // ...but the router still gates which of those commands actually run:
    expect(svc.commandAllowed('guestchan', 'points')).toBe(false);
  });
});

describe('GuestChannelService connect/disconnect', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('joins + greets on connect, parts + farewells on disconnect', async () => {
    const { svc, say, join, part } = make();
    expect(await svc.connect('guestchan', 60)).toBe(true);
    expect(join).toHaveBeenCalledWith('guestchan');
    expect(say).toHaveBeenCalledWith('guestchan', expect.stringContaining('auto-leave'));
    expect(svc.isGuest('guestchan')).toBe(true);

    const left = await svc.disconnect(true);
    expect(left).toBe('guestchan');
    expect(part).toHaveBeenCalledWith('guestchan');
    expect(svc.isGuest('guestchan')).toBe(false);
  });

  it('auto-disconnects after the timeout', async () => {
    const { svc, part } = make();
    await svc.connect('guestchan', 60);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(part).toHaveBeenCalledWith('guestchan');
    expect(svc.guestChannel()).toBeNull();
  });

  it('returns null when disconnecting with no active guest', async () => {
    const { svc, part } = make();
    expect(await svc.disconnect(true)).toBeNull();
    expect(part).not.toHaveBeenCalled();
  });

  it('reports false and does not set a guest when the join fails', async () => {
    const { svc, join } = make();
    join.mockRejectedValue(new Error('nope'));
    expect(await svc.connect('guestchan', 60)).toBe(false);
    expect(svc.guestChannel()).toBeNull();
  });
});
