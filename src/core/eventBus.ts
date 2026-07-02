import type { BotEvent, BotEventType, EventOfType } from './events.js';
import { scopedLogger } from '../services/logger.js';

const log = scopedLogger('eventBus');

export type EventHandler<T extends BotEventType> = (
  event: EventOfType<T>,
) => void | Promise<void>;

type AnyHandler = (event: BotEvent) => void | Promise<void>;

/** Unsubscribe function returned by `on`. */
export type Unsubscribe = () => void;

/**
 * Typed publish/subscribe bus for BotEvents.
 *
 * - `on(type, handler)` subscribes to one event type with full type inference.
 * - `onAny(handler)` observes every event (useful for logging/metrics).
 * - `publish(event)` fans out to matching handlers. Handlers are awaited but
 *   isolated: one throwing handler never blocks the others.
 */
export class EventBus {
  private readonly handlers = new Map<BotEventType, Set<AnyHandler>>();
  private readonly wildcard = new Set<AnyHandler>();

  on<T extends BotEventType>(type: T, handler: EventHandler<T>): Unsubscribe {
    let set = this.handlers.get(type);
    if (!set) {
      set = new Set();
      this.handlers.set(type, set);
    }
    const wrapped = handler as AnyHandler;
    set.add(wrapped);
    return () => set!.delete(wrapped);
  }

  onAny(handler: AnyHandler): Unsubscribe {
    this.wildcard.add(handler);
    return () => this.wildcard.delete(handler);
  }

  async publish(event: BotEvent): Promise<void> {
    const targets = [...(this.handlers.get(event.type) ?? []), ...this.wildcard];
    await Promise.all(
      targets.map(async (handler) => {
        try {
          await handler(event);
        } catch (err) {
          log.error({ err, eventType: event.type }, 'event handler threw');
        }
      }),
    );
  }

  /** Remove all subscriptions (used on shutdown / in tests). */
  clear(): void {
    this.handlers.clear();
    this.wildcard.clear();
  }
}
