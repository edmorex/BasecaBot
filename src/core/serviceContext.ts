import type { EventBus } from './eventBus.js';
import type { CommandRouter } from './commandRouter.js';
import type { ChatService } from '../services/chat.js';
import type { UsersService } from '../services/users.js';
import type { PointsService } from '../services/points.js';
import type { CustomCommandService } from '../services/customCommands.js';
import type { Storage } from '../services/storage/index.js';
import type { WsHub } from '../web/wsHub.js';
import type { AppConfig } from '../services/config.js';
import type { Logger } from '../services/logger.js';

/**
 * The single object injected into every plugin's `init`. Plugins interact with
 * the rest of the bot ONLY through this context — they never import the kernel
 * internals or each other. This is the extensibility contract.
 */
export interface ServiceContext {
  /** Typed pub/sub for all BotEvents. */
  readonly bus: EventBus;
  /** Register `!command` handlers with permissions/cooldowns. */
  readonly commands: CommandRouter;
  /** Send messages to chat. */
  readonly chat: ChatService;
  /** Remember and look up users. */
  readonly users: UsersService;
  /** The points economy. */
  readonly points: PointsService;
  /** Custom command storage + matching (triggers & phrases). */
  readonly customCommands: CustomCommandService;
  /** Raw persistence (Prisma) for plugin-specific tables/queries. */
  readonly storage: Storage;
  /** Push/receive messages to connected web apps. */
  readonly ws: WsHub;
  /** Validated app configuration. */
  readonly config: AppConfig;
  /** Logger scoped to the plugin. */
  readonly logger: Logger;
}
