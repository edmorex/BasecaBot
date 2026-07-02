import { describe, it, expect, vi, beforeEach } from 'vitest';
import { eventSimulatorPlugin } from './index.js';
import { EventBus } from '../../core/eventBus.js';
import type { ServiceContext } from '../../core/serviceContext.js';
import type { WsMessageEvent } from '../../core/events.js';

function wsMessage(messageType: string, payload: unknown): WsMessageEvent {
  return { type: 'wsMessage', channel: 'mychan', room: 'event-sim', messageType, payload, ts: Date.now() };
}

function makeCtx(enabled: boolean) {
  const bus = new EventBus();
  const touch = vi.fn(async () => ({}));
  const broadcast = vi.fn();
  const ctx = {
    bus,
    users: { touch },
    ws: { broadcast },
    config: { eventSim: { enabled } },
    logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  } as unknown as ServiceContext;
  return { bus, touch, broadcast, ctx };
}

describe('eventSimulator plugin', () => {
  describe('when disabled', () => {
    it('registers no handlers', async () => {
      const { bus, ctx } = makeCtx(false);
      const seen = vi.fn();
      bus.on('sub', seen);
      await eventSimulatorPlugin().init(ctx);
      await bus.publish(wsMessage('sub', { user: 'Bob' }));
      expect(seen).not.toHaveBeenCalled();
    });
  });

  describe('when enabled', () => {
    let bus: EventBus;
    let touch: ReturnType<typeof vi.fn>;
    let broadcast: ReturnType<typeof vi.fn>;

    beforeEach(async () => {
      const built = makeCtx(true);
      bus = built.bus;
      touch = built.touch;
      broadcast = built.broadcast;
      await eventSimulatorPlugin().init(built.ctx);
    });

    it('translates a sub, ensuring the user exists first', async () => {
      const onSub = vi.fn();
      bus.on('sub', onSub);
      await bus.publish(wsMessage('sub', { user: 'Bob', tier: '2000', months: 3, message: 'yo' }));

      expect(touch).toHaveBeenCalledWith(expect.objectContaining({ displayName: 'Bob', id: 'sim-bob' }));
      expect(onSub).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'sub', channel: 'mychan', tier: '2000', months: 3, message: 'yo' }),
      );
    });

    it('applies defaults for missing fields', async () => {
      const onBits = vi.fn();
      bus.on('bits', onBits);
      await bus.publish(wsMessage('bits', {})); // no fields
      expect(onBits).toHaveBeenCalledWith(expect.objectContaining({ type: 'bits', amount: 100 }));
    });

    it('translates raid and donation without a user touch', async () => {
      const onRaid = vi.fn();
      const onDonation = vi.fn();
      bus.on('raid', onRaid);
      bus.on('donation', onDonation);
      await bus.publish(wsMessage('raid', { fromLogin: 'bigstreamer', viewers: 300 }));
      await bus.publish(wsMessage('donation', { fromName: 'Kai', amount: 25, currency: 'EUR' }));

      expect(onRaid).toHaveBeenCalledWith(expect.objectContaining({ fromLogin: 'bigstreamer', viewers: 300 }));
      expect(onDonation).toHaveBeenCalledWith(expect.objectContaining({ fromName: 'Kai', amount: 25, currency: 'EUR' }));
      expect(touch).not.toHaveBeenCalled();
    });

    it('acks back to the harness after injecting', async () => {
      await bus.publish(wsMessage('follow', { user: 'Fern' }));
      expect(broadcast).toHaveBeenCalledWith('event-sim', 'ack', { injected: 'follow' });
    });

    it('ignores messages from other rooms', async () => {
      const onSub = vi.fn();
      bus.on('sub', onSub);
      await bus.publish({ ...wsMessage('sub', { user: 'Bob' }), room: 'some-other-room' });
      expect(onSub).not.toHaveBeenCalled();
    });

    it('ignores unknown event types', async () => {
      await bus.publish(wsMessage('nonsense', {}));
      expect(broadcast).not.toHaveBeenCalled();
    });
  });
});
