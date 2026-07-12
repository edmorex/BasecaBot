import { describe, it, expect, vi, beforeEach } from 'vitest';
import { basecaWheelPlugin } from './index.js';
import { EventBus } from '../../core/eventBus.js';
import { CommandRouter } from '../../core/commandRouter.js';
import { PermissionLevel, type ChatEvent, type EventUser } from '../../core/events.js';
import type { ServiceContext } from '../../core/serviceContext.js';
import type { ChatService } from '../../services/chat.js';

function user(overrides: Partial<EventUser> = {}): EventUser {
  return { id: '1', login: 'alice', displayName: 'Alice', permission: PermissionLevel.Viewer, ...overrides };
}

function chat(message: string, u = user()): ChatEvent {
  return { type: 'chat', channel: 'test', ts: Date.now(), message, user: u };
}

describe('basecaWheel plugin', () => {
  let bus: EventBus;
  let say: ReturnType<typeof vi.fn>;
  let broadcast: ReturnType<typeof vi.fn>;
  let join: ReturnType<typeof vi.fn>;
  let part: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    bus = new EventBus();
    say = vi.fn(async () => {});
    broadcast = vi.fn();
    join = vi.fn(async () => {});
    part = vi.fn();
    const chatSvc = { say, reply: vi.fn(), whisper: vi.fn(), join, part } as unknown as ChatService;
    const commands = new CommandRouter(bus, chatSvc);
    const ctx = {
      bus,
      commands,
      chat: chatSvc,
      ws: { broadcast },
      config: { twitch: { channel: 'test' } },
      logger: { debug: vi.fn(), info: vi.fn(), error: vi.fn() },
    } as unknown as ServiceContext;
    await basecaWheelPlugin().init(ctx);
  });

  it('forwards a title command with the display name and permission int', async () => {
    await bus.publish(chat('!wheel title Best Game Ever', user({ displayName: 'Bob', permission: PermissionLevel.Moderator })));
    expect(broadcast).toHaveBeenCalledWith('baseca-wheel', 'wheel', {
      command: 'title',
      text: 'Best Game Ever',
      user: 'Bob',
      permission: PermissionLevel.Moderator, // 3
      channel: 'test',
    });
  });

  it('forwards an add command preserving multi-word text', async () => {
    await bus.publish(chat('!wheel add Sir Reginald III'));
    expect(broadcast).toHaveBeenCalledWith('baseca-wheel', 'wheel', {
      command: 'add',
      text: 'Sir Reginald III',
      user: 'Alice',
      permission: 0,
      channel: 'test',
    });
  });

  it('forwards spin with empty text', async () => {
    await bus.publish(chat('!wheel spin'));
    expect(broadcast).toHaveBeenCalledWith('baseca-wheel', 'wheel', expect.objectContaining({ command: 'spin', text: '' }));
  });

  it('forwards clear with empty text and the caller identity/permission', async () => {
    await bus.publish(chat('!wheel clear', user({ displayName: 'Bob', permission: PermissionLevel.Subscriber })));
    expect(broadcast).toHaveBeenCalledWith('baseca-wheel', 'wheel', {
      command: 'clear',
      text: '',
      user: 'Bob',
      permission: PermissionLevel.Subscriber, // 2
      channel: 'test',
    });
  });

  it('forwards clearall with empty text and the caller identity/permission', async () => {
    await bus.publish(chat('!wheel clearall', user({ displayName: 'Mod', permission: PermissionLevel.Moderator })));
    expect(broadcast).toHaveBeenCalledWith('baseca-wheel', 'wheel', {
      command: 'clearall',
      text: '',
      user: 'Mod',
      permission: PermissionLevel.Moderator, // 3
      channel: 'test',
    });
  });

  it('ignores any trailing text on action-only subcommands', async () => {
    await bus.publish(chat('!wheel spin right now please'));
    expect(broadcast).toHaveBeenCalledWith('baseca-wheel', 'wheel', expect.objectContaining({ command: 'spin', text: '' }));
  });

  it('shows usage for an unknown subcommand and does not broadcast', async () => {
    await bus.publish(chat('!wheel frobnicate'));
    expect(broadcast).not.toHaveBeenCalled();
    expect(say).toHaveBeenCalledOnce();
  });

  it('requires text for title/add', async () => {
    await bus.publish(chat('!wheel add'));
    expect(broadcast).not.toHaveBeenCalled();
    expect(say).toHaveBeenCalledOnce();
  });

  it('announces a spin result sent back from the app', async () => {
    await bus.publish({
      type: 'wsMessage',
      channel: 'test',
      room: 'baseca-wheel',
      messageType: 'result',
      payload: { winner: 'Alice' },
      ts: Date.now(),
    });
    expect(say).toHaveBeenCalledWith('test', expect.stringContaining('Alice'));
  });

  it('routes app responses to the channel echoed back in the payload', async () => {
    await bus.publish({
      type: 'wsMessage',
      channel: 'test', // hub default (primary)
      room: 'baseca-wheel',
      messageType: 'announce',
      payload: { text: 'Round over!', channel: 'guestchan' }, // echoed guest channel wins
      ts: Date.now(),
    });
    expect(say).toHaveBeenCalledWith('guestchan', 'Round over!');
  });

  it('lets a broadcaster connect to a guest channel (joins + greets both)', async () => {
    await bus.publish(chat('!wheel connect GuestChan 60', user({ permission: PermissionLevel.Broadcaster })));
    expect(join).toHaveBeenCalledWith('guestchan');
    expect(say).toHaveBeenCalledWith('guestchan', expect.stringContaining('BasecaWheel'));
    expect(say).toHaveBeenCalledWith('test', expect.stringContaining('Connected to guestchan'));
  });

  it('does not let a non-broadcaster connect to a guest channel', async () => {
    await bus.publish(chat('!wheel connect guestchan', user({ permission: PermissionLevel.Moderator })));
    expect(join).not.toHaveBeenCalled();
  });
});
