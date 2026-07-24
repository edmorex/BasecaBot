import { describe, it, expect, vi, beforeEach } from 'vitest';
import { timersPlugin } from './index.js';
import { EventBus } from '../../core/eventBus.js';
import { CommandRouter } from '../../core/commandRouter.js';
import { PermissionLevel, type ChatEvent, type EventUser } from '../../core/events.js';
import type { ServiceContext } from '../../core/serviceContext.js';
import type { ChatService } from '../../services/chat.js';
import { TimerError } from '../../services/timers.js';

function user(overrides: Partial<EventUser> = {}): EventUser {
  return { id: 'm1', login: 'mandy', displayName: 'Mandy', permission: PermissionLevel.Moderator, ...overrides };
}
function chat(message: string, u = user()): ChatEvent {
  return { type: 'chat', channel: 'baseca', ts: Date.now(), message, user: u };
}

describe('timers plugin', () => {
  let bus: EventBus;
  let commands: CommandRouter;
  let say: ReturnType<typeof vi.fn>;
  let timers: {
    configure: ReturnType<typeof vi.fn>;
    add: ReturnType<typeof vi.fn>;
    start: ReturnType<typeof vi.fn>;
    loop: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    edit: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
    get: ReturnType<typeof vi.fn>;
    resumeLoops: ReturnType<typeof vi.fn>;
    stopAllRuntime: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    bus = new EventBus();
    say = vi.fn(async () => {});
    timers = {
      configure: vi.fn(),
      add: vi.fn(async (name: string, period: number, command: string) => ({ name, periodSeconds: period, command, looping: false })),
      start: vi.fn(async (name: string) => ({ name, periodSeconds: 60, command: '!socials', looping: false })),
      loop: vi.fn(async (name: string) => ({ name, periodSeconds: 60, command: '!socials', looping: true })),
      stop: vi.fn(async (name: string) => ({ name, periodSeconds: 60, command: '!socials', looping: false })),
      edit: vi.fn(async (name: string, period: number, command: string) => ({ name, periodSeconds: period, command, looping: false })),
      delete: vi.fn(async () => undefined),
      get: vi.fn(async (name: string) => ({ name, periodSeconds: 60, command: '!socials', looping: true, running: true, mode: 'loop', secondsLeft: 42 })),
      resumeLoops: vi.fn(async () => undefined),
      stopAllRuntime: vi.fn(),
    };

    const chatSvc = { say, reply: vi.fn(), whisper: vi.fn(), join: vi.fn(), part: vi.fn() } as unknown as ChatService;
    commands = new CommandRouter(bus, chatSvc);
    const ctx = {
      bus,
      commands,
      chat: chatSvc,
      timers,
      api: { users: { getUserByName: vi.fn(async () => ({ id: 'b1', name: 'baseca', displayName: 'Baseca' })) }, streams: { getStreamByUserId: vi.fn(async () => ({})) } },
      config: { twitch: { broadcasterUsername: 'baseca', channel: 'baseca' } },
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as unknown as ServiceContext;
    await timersPlugin().init(ctx);
  });

  const last = () => String(say.mock.calls.at(-1)?.[1] ?? '');

  it('wires the fire + live callbacks into the service on init', () => {
    expect(timers.configure).toHaveBeenCalledTimes(1);
    const arg = timers.configure.mock.calls[0]![0] as { fire: unknown; isLive: unknown };
    expect(typeof arg.fire).toBe('function');
    expect(typeof arg.isLive).toBe('function');
  });

  it('add creates a timer and confirms', async () => {
    await bus.publish(chat('!timer add Socials 60 !socials'));
    expect(timers.add).toHaveBeenCalledWith('Socials', 60, '!socials');
    expect(last()).toBe('Timer "Socials" created — runs !socials every 60s. Start it with !timer start Socials or !timer loop Socials.');
  });

  it('add keeps command options together', async () => {
    await bus.publish(chat('!timer add raidprep 45 !shoutout @baseca and friends'));
    expect(timers.add).toHaveBeenCalledWith('raidprep', 45, '!shoutout @baseca and friends');
  });

  it('start / loop / stop confirm and hit the service', async () => {
    await bus.publish(chat('!timer start Socials'));
    expect(timers.start).toHaveBeenCalledWith('Socials');
    expect(last()).toBe('Timer "Socials" started — !socials fires in 60s.');

    await bus.publish(chat('!timer loop Socials'));
    expect(timers.loop).toHaveBeenCalledWith('Socials');
    expect(last()).toBe('Timer "Socials" looping — !socials every 60s.');

    await bus.publish(chat('!timer stop Socials'));
    expect(timers.stop).toHaveBeenCalledWith('Socials');
    expect(last()).toBe('Timer "Socials" stopped.');
  });

  it('supports subcommand aliases (go / repeat / cancel / remaining)', async () => {
    await bus.publish(chat('!timer go Socials'));
    expect(timers.start).toHaveBeenCalled();
    await bus.publish(chat('!timer repeat Socials'));
    expect(timers.loop).toHaveBeenCalled();
    await bus.publish(chat('!timer cancel Socials'));
    expect(timers.stop).toHaveBeenCalled();
    await bus.publish(chat('!timer remaining Socials'));
    expect(last()).toBe('Timer "Socials" fires in 42s (looping).');
  });

  it('status reports "not running" when idle', async () => {
    timers.get.mockResolvedValueOnce({ name: 'Socials', periodSeconds: 60, command: '!socials', looping: false, running: false, mode: null, secondsLeft: 0 });
    await bus.publish(chat('!timer status Socials'));
    expect(last()).toBe('Timer "Socials" is not running.');
  });

  it('delete and edit work', async () => {
    await bus.publish(chat('!timer delete socials'));
    expect(timers.delete).toHaveBeenCalledWith('socials');
    expect(last()).toBe('Timer "socials" deleted.');

    await bus.publish(chat('!timer edit Socials 120 !socials2'));
    expect(timers.edit).toHaveBeenCalledWith('Socials', 120, '!socials2');
    expect(last()).toBe('Timer "Socials" updated — runs !socials2 every 120s.');
  });

  it('surfaces a TimerError from bad usage as a chat message', async () => {
    await bus.publish(chat('!timer add onlytwo 60'));
    expect(timers.add).not.toHaveBeenCalled();
    expect(last()).toContain('Usage:');

    timers.start.mockRejectedValueOnce(new TimerError('No timer named "ghost".'));
    await bus.publish(chat('!timer start ghost'));
    expect(last()).toBe('No timer named "ghost".');
  });

  it('is mod-gated: a viewer cannot manage timers', async () => {
    await bus.publish(chat('!timer add Sneaky 60 !socials', user({ id: 'v1', login: 'vince', displayName: 'Vince', permission: PermissionLevel.Viewer })));
    expect(timers.add).not.toHaveBeenCalled();
  });

  it('fire callback runs the bound command as the broadcaster (no chat side effects)', async () => {
    const execute = vi.spyOn(commands, 'execute').mockResolvedValue(undefined);
    const arg = timers.configure.mock.calls[0]![0] as { fire: (c: string) => Promise<void> };
    await arg.fire('!socials');
    expect(execute).toHaveBeenCalledTimes(1);
    const [message, base] = execute.mock.calls[0]!;
    expect(message).toBe('!socials');
    expect(base).toMatchObject({ channel: 'baseca', user: { id: 'b1', login: 'baseca', permission: PermissionLevel.Broadcaster } });
  });
});
