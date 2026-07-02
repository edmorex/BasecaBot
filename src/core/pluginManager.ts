import type { Plugin, PluginFactory } from '../plugins/types.js';
import type { ServiceContext } from './serviceContext.js';
import { scopedLogger } from '../services/logger.js';

const log = scopedLogger('pluginManager');

/**
 * Loads plugins and drives their lifecycle. Plugins are supplied as factories
 * from the registry (`plugins/index.ts`); this manager filters out disabled
 * ones, runs `init` for all, then `start` for all, and `stop`s them in reverse
 * on shutdown.
 */
export class PluginManager {
  private readonly active: Plugin[] = [];

  constructor(
    private readonly ctx: ServiceContext,
    private readonly disabled: Set<string>,
  ) {}

  async loadAll(factories: PluginFactory[]): Promise<void> {
    const plugins = factories.map((f) => f());

    for (const plugin of plugins) {
      if (this.disabled.has(plugin.name)) {
        log.info({ plugin: plugin.name }, 'plugin disabled; skipping');
        continue;
      }
      try {
        await plugin.init(this.ctx);
        this.active.push(plugin);
        log.info({ plugin: plugin.name, version: plugin.version }, 'plugin initialized');
      } catch (err) {
        log.error({ err, plugin: plugin.name }, 'plugin init failed; skipping');
      }
    }

    for (const plugin of this.active) {
      try {
        await plugin.start?.();
      } catch (err) {
        log.error({ err, plugin: plugin.name }, 'plugin start failed');
      }
    }
  }

  async stopAll(): Promise<void> {
    for (const plugin of [...this.active].reverse()) {
      try {
        await plugin.stop?.();
        log.info({ plugin: plugin.name }, 'plugin stopped');
      } catch (err) {
        log.error({ err, plugin: plugin.name }, 'plugin stop failed');
      }
    }
    this.active.length = 0;
  }

  list(): string[] {
    return this.active.map((p) => p.name);
  }
}
