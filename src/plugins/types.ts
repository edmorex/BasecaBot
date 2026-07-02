import type { ServiceContext } from '../core/serviceContext.js';

/**
 * A feature/mode/game is a Plugin. Adding one = creating a folder under
 * `src/plugins/` that default-exports (or named-exports) a Plugin, and
 * registering it in the plugin registry. No kernel changes required.
 *
 * Lifecycle: `init(ctx)` (register handlers) -> `start()` (begin activity)
 * -> `stop()` (clean up) on shutdown.
 */
export interface Plugin {
  /** Unique, stable name. Used for enable/disable and logging. */
  readonly name: string;
  readonly version: string;
  /** Register command/event handlers here using the injected context. */
  init(ctx: ServiceContext): void | Promise<void>;
  /** Optional: begin timers / background work after all plugins are initialized. */
  start?(): void | Promise<void>;
  /** Optional: release resources on shutdown. */
  stop?(): void | Promise<void>;
}

/** Factory signature for lazily constructing a plugin (keeps ctx out of module scope). */
export type PluginFactory = () => Plugin;
