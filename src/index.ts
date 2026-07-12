import { loadConfig } from './services/config.js';
import { logger, scopedLogger } from './services/logger.js';
import { EventBus } from './core/eventBus.js';
import { CommandRouter } from './core/commandRouter.js';
import { PluginManager } from './core/pluginManager.js';
import type { ServiceContext } from './core/serviceContext.js';
import { Storage } from './services/storage/index.js';
import { UsersService } from './services/users.js';
import { PointsService } from './services/points.js';
import { CustomCommandService } from './services/customCommands.js';
import { ListsService } from './services/lists.js';
import { QuotesService } from './services/quotes.js';
import { TwurpleChatService } from './services/chat.js';
import { WsHub } from './web/wsHub.js';
import { WebServer } from './web/webServer.js';
import { ChannelRelationshipService } from './web/auth/channelRelationship.js';
import { createAuthProvider } from './adapters/twitch/auth.js';
import { TwitchChatAdapter } from './adapters/twitch/chatAdapter.js';
import { TwitchEventSubAdapter } from './adapters/twitch/eventSubAdapter.js';
import { pluginRegistry } from './plugins/index.js';
import { ApiClient } from '@twurple/api';

const log = scopedLogger('bootstrap');

/**
 * Composition root: wires services -> adapters -> plugins and manages the
 * process lifecycle. Everything is constructed here and injected; nothing
 * reaches for globals, which keeps the codebase testable and server-portable.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  log.info({ channels: config.twitch.channels }, 'starting BasecaBot');

  // ── Core services ────────────────────────────────────────────────────────
  const bus = new EventBus();
  const storage = new Storage();
  await storage.connect();

  const users = new UsersService(storage);
  const points = new PointsService(storage);
  const customCommands = new CustomCommandService(storage);
  await customCommands.init(); // load the phrase-matching cache
  const lists = new ListsService(storage);
  const quotes = new QuotesService(storage);

  // ── Twitch auth + chat client ──────────────────────────────────────────────
  const authProvider = await createAuthProvider(config);
  const api = new ApiClient({ authProvider });
  const chatAdapter = new TwitchChatAdapter(authProvider, bus, users, config);
  const chat = new TwurpleChatService(chatAdapter.client);

  const commands = new CommandRouter(bus, chat);
  // Block custom commands/aliases from shadowing built-in (plugin) commands.
  customCommands.useReservedWords((word) => commands.isRegistered(word));

  // ── WebSocket hub (web-app integration) ────────────────────────────────────
  const ws = new WsHub(bus, {
    port: config.ws.port,
    secret: config.ws.secret,
    channel: config.twitch.channels[0] ?? 'unknown',
  });
  ws.start();

  // ── Web dashboard + "Login with Twitch" ────────────────────────────────────
  const broadcasterUser = await api.users.getUserByName(config.twitch.broadcasterUsername);
  if (!broadcasterUser) {
    log.warn({ user: config.twitch.broadcasterUsername }, 'broadcaster not found; relationship checks will be limited');
  }
  const relationships = new ChannelRelationshipService(api, config, broadcasterUser?.id ?? '');
  const webServer = new WebServer(config, relationships, users, customCommands, commands, lists, quotes);
  webServer.start();

  // ── Plugins ────────────────────────────────────────────────────────────────
  const ctx: ServiceContext = {
    bus,
    commands,
    chat,
    users,
    points,
    customCommands,
    lists,
    quotes,
    storage,
    ws,
    api,
    config,
    logger: logger.child({ scope: 'plugin' }),
  };
  const plugins = new PluginManager(ctx, new Set(config.disabledPlugins));
  await plugins.loadAll(pluginRegistry);
  log.info({ plugins: plugins.list() }, 'plugins loaded');

  // ── Connect to Twitch ────────────────────────────────────────────────────
  await chatAdapter.connect();
  const eventSub = new TwitchEventSubAdapter(api, bus, config);
  await eventSub.start();

  log.info('BasecaBot is running');

  // ── Graceful shutdown ──────────────────────────────────────────────────────
  const shutdown = async (signal: string) => {
    log.info({ signal }, 'shutting down');
    await plugins.stopAll();
    await eventSub.stop();
    await chatAdapter.disconnect();
    await webServer.stop();
    await ws.stop();
    await storage.disconnect();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.fatal({ err }, 'fatal error during startup');
  process.exit(1);
});
