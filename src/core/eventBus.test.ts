import { describe, it, expect, vi } from 'vitest';
import { EventBus } from './eventBus.js';
import { PermissionLevel, type ChatEvent } from './events.js';

function chat(message: string): ChatEvent {
  return {
    type: 'chat',
    channel: 'test',
    ts: Date.now(),
    message,
    user: { id: '1', login: 'alice', displayName: 'Alice', permission: PermissionLevel.Viewer },
  };
}

describe('EventBus', () => {
  it('delivers events to type-matched handlers only', async () => {
    const bus = new EventBus();
    const chatHandler = vi.fn();
    const subHandler = vi.fn();
    bus.on('chat', chatHandler);
    bus.on('sub', subHandler);

    await bus.publish(chat('hi'));

    expect(chatHandler).toHaveBeenCalledOnce();
    expect(subHandler).not.toHaveBeenCalled();
  });

  it('delivers to wildcard handlers', async () => {
    const bus = new EventBus();
    const any = vi.fn();
    bus.onAny(any);
    await bus.publish(chat('hi'));
    expect(any).toHaveBeenCalledOnce();
  });

  it('isolates a throwing handler from the others', async () => {
    const bus = new EventBus();
    const good = vi.fn();
    bus.on('chat', () => {
      throw new Error('boom');
    });
    bus.on('chat', good);
    await expect(bus.publish(chat('hi'))).resolves.toBeUndefined();
    expect(good).toHaveBeenCalledOnce();
  });

  it('unsubscribes correctly', async () => {
    const bus = new EventBus();
    const handler = vi.fn();
    const off = bus.on('chat', handler);
    off();
    await bus.publish(chat('hi'));
    expect(handler).not.toHaveBeenCalled();
  });
});
