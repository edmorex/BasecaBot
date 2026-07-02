import type { EventBus } from './eventBus.js';
import type { ChatService } from '../services/chat.js';
import { PermissionLevel, type ChatEvent, type CommandEvent, type EventUser } from './events.js';
import { scopedLogger } from '../services/logger.js';

const log = scopedLogger('commandRouter');

export const COMMAND_PREFIX = '!';

/** A registered command handler. Plugins capture their own ServiceContext in the closure. */
export type CommandHandler = (event: CommandEvent) => void | Promise<void>;

export interface CommandOptions {
  /** Minimum permission required to run (default: Viewer). */
  permission?: PermissionLevel;
  /** Per-user cooldown in seconds (default: 0 = none). */
  cooldownSeconds?: number;
  /** Global (all-users) cooldown in seconds (default: 0 = none). */
  globalCooldownSeconds?: number;
  /** Alternative names that map to the same handler. */
  aliases?: string[];
  /** Human-readable description for help output. */
  description?: string;
}

interface RegisteredCommand extends Required<Omit<CommandOptions, 'aliases' | 'description'>> {
  name: string;
  handler: CommandHandler;
  description: string;
  perUserLastRun: Map<string, number>;
  lastGlobalRun: number;
}

/**
 * Parses chat messages into commands and dispatches them to registered handlers,
 * enforcing permission levels and cooldowns.
 *
 * Both code-defined (plugin) commands and dynamic (DB-defined) commands flow
 * through here: dynamic commands are served by a `fallback` resolver so unknown
 * command names can still be answered by the custom-commands plugin.
 */
export class CommandRouter {
  private readonly commands = new Map<string, RegisteredCommand>();
  private readonly aliasIndex = new Map<string, string>();
  private fallback: CommandHandler | undefined;

  constructor(
    private readonly bus: EventBus,
    private readonly chat: ChatService,
  ) {
    this.bus.on('chat', (event) => this.handleChat(event));
  }

  register(name: string, handler: CommandHandler, options: CommandOptions = {}): void {
    const key = name.toLowerCase();
    if (this.commands.has(key)) {
      log.warn({ command: key }, 'command already registered; overwriting');
    }
    const cmd: RegisteredCommand = {
      name: key,
      handler,
      permission: options.permission ?? PermissionLevel.Viewer,
      cooldownSeconds: options.cooldownSeconds ?? 0,
      globalCooldownSeconds: options.globalCooldownSeconds ?? 0,
      description: options.description ?? '',
      perUserLastRun: new Map(),
      lastGlobalRun: 0,
    };
    this.commands.set(key, cmd);
    for (const alias of options.aliases ?? []) {
      this.aliasIndex.set(alias.toLowerCase(), key);
    }
    log.debug({ command: key }, 'registered command');
  }

  unregister(name: string): void {
    const key = name.toLowerCase();
    this.commands.delete(key);
    for (const [alias, target] of this.aliasIndex) {
      if (target === key) this.aliasIndex.delete(alias);
    }
  }

  /** Register a resolver for command names that have no explicit handler. */
  setFallback(handler: CommandHandler): void {
    this.fallback = handler;
  }

  /** List registered commands (for help/introspection). */
  list(): { name: string; description: string; permission: PermissionLevel }[] {
    return [...this.commands.values()].map((c) => ({
      name: c.name,
      description: c.description,
      permission: c.permission,
    }));
  }

  /** Parse a raw message into a CommandEvent, or undefined if it isn't a command. */
  static parse(message: string, base: Omit<CommandEvent, 'type' | 'name' | 'argString' | 'args' | 'raw'>): CommandEvent | undefined {
    if (!message.startsWith(COMMAND_PREFIX)) return undefined;
    const withoutPrefix = message.slice(COMMAND_PREFIX.length).trimEnd();
    if (!withoutPrefix) return undefined;
    const firstSpace = withoutPrefix.indexOf(' ');
    const name = (firstSpace === -1 ? withoutPrefix : withoutPrefix.slice(0, firstSpace)).toLowerCase();
    const argString = firstSpace === -1 ? '' : withoutPrefix.slice(firstSpace + 1).trim();
    const args = argString.length ? argString.split(/\s+/) : [];
    return { type: 'command', ...base, name, argString, args, raw: message };
  }

  private async handleChat(event: ChatEvent): Promise<void> {
    const parsed = CommandRouter.parse(event.message, {
      channel: event.channel,
      ts: event.ts,
      user: event.user,
    });
    if (!parsed) return;

    const cmd = this.resolve(parsed.name);
    if (!cmd) {
      if (this.fallback) await this.fallback(parsed);
      return;
    }

    if (!this.checkPermission(parsed.user, cmd.permission)) {
      log.debug({ command: cmd.name, user: parsed.user.login }, 'permission denied');
      return;
    }
    if (!this.checkCooldown(cmd, parsed.user.id)) return;

    // Also publish the command event so plugins can observe raw command traffic.
    await this.bus.publish(parsed);

    try {
      await cmd.handler(parsed);
    } catch (err) {
      log.error({ err, command: cmd.name }, 'command handler threw');
      await this.chat.say(event.channel, `Something went wrong running !${cmd.name}.`).catch(() => {});
    }
  }

  private resolve(name: string): RegisteredCommand | undefined {
    const direct = this.commands.get(name);
    if (direct) return direct;
    const aliased = this.aliasIndex.get(name);
    return aliased ? this.commands.get(aliased) : undefined;
  }

  private checkPermission(user: EventUser, required: PermissionLevel): boolean {
    return user.permission >= required;
  }

  private checkCooldown(cmd: RegisteredCommand, userId: string): boolean {
    const now = Date.now();
    if (cmd.globalCooldownSeconds > 0 && now - cmd.lastGlobalRun < cmd.globalCooldownSeconds * 1000) {
      return false;
    }
    if (cmd.cooldownSeconds > 0) {
      const last = cmd.perUserLastRun.get(userId) ?? 0;
      if (now - last < cmd.cooldownSeconds * 1000) return false;
    }
    cmd.lastGlobalRun = now;
    cmd.perUserLastRun.set(userId, now);
    return true;
  }
}
