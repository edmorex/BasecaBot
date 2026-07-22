import type { PluginFactory } from './types.js';
import { pointsPlugin } from './points/index.js';
import { commandsPlugin } from './commands/index.js';
import { listsPlugin } from './lists/index.js';
import { quotesPlugin } from './quotes/index.js';
import { eventsPlugin } from './events/index.js';
import { basecaWheelPlugin } from './basecaWheel/index.js';

/**
 * The plugin registry. To add a feature/mode/game: create a folder under
 * `src/plugins/`, export a Plugin factory, and add it to this list. Nothing
 * else in the kernel changes. Toggle a plugin off at runtime via DISABLED_PLUGINS.
 */
export const pluginRegistry: PluginFactory[] = [
  pointsPlugin,
  commandsPlugin,
  listsPlugin,
  quotesPlugin,
  eventsPlugin,
  basecaWheelPlugin,
];
