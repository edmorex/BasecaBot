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

  beforeEach(async () => {
    bus = new EventBus();
    say = vi.fn(async () => {});
    broadcast = vi.fn();
    const chatSvc = { say, reply: vi.fn(), whisper: vi.fn() } as unknown as ChatService;
    const commands = new CommandRouter(bus, chatSvc);
    const ctx = {
      bus,
      commands,
      chat: chatSvc,
      ws: { broadcast },
      logger: { debug: vi.fn() },
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
    });
  });

  it('forwards an add command preserving multi-word text', async () => {
    await bus.publish(chat('!wheel add Sir Reginald III'));
    expect(broadcast).toHaveBeenCalledWith('baseca-wheel', 'wheel', {
      command: 'add',
      text: 'Sir Reginald III',
      user: 'Alice',
      permission: 0,
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
    });
  });

  it('forwards reset with empty text and the caller identity/permission', async () => {
    await bus.publish(chat('!wheel reset', user({ displayName: 'Mod', permission: PermissionLevel.Moderator })));
    expect(broadcast).toHaveBeenCalledWith('baseca-wheel', 'wheel', {
      command: 'reset',
      text: '',
      user: 'Mod',
      permission: PermissionLevel.Moderator, // 3
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
});
