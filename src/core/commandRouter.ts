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
  /** Argument signature shown after the command name, e.g. `<user> <amount>`. */
  usage?: string;
  /** Grouping label (usually the registering plugin) for help/dashboard sections. */
  group?: string;
}

/** One subcommand of a primary command (e.g. `title` of `!wheel title`). */
export interface SubcommandSpec {
  description?: string;
  /** Argument signature shown after the command, e.g. `<text>`. */
  usage?: string;
  /** Defaults to the group's permission. */
  permission?: PermissionLevel;
  /** Per-user cooldown, seconds (0 = none). */
  cooldownSeconds?: number;
  /** Global cooldown, seconds (0 = none). */
  globalCooldownSeconds?: number;
  /** Alternate names for this subcommand (e.g. `dump`/`show` for `all`). */
  aliases?: string[];
  /** Handler; receives the event with the subcommand token stripped from args/argString. */
  handler: CommandHandler;
}

/** Options for a primary command that dispatches to named subcommands. */
export interface GroupOptions {
  /** Usage/description printed when no valid subcommand is given, and shown in help. */
  description?: string;
  /** Default permission for the primary and its subcommands. */
  permission?: PermissionLevel;
  aliases?: string[];
  group?: string;
  subcommands: Record<string, SubcommandSpec>;
  /** Custom handler for missing/invalid subcommand (defaults to printing `description`). */
  onUnknown?: CommandHandler;
}

/** Shared cooldown state shape for commands and subcommands. */
interface Cooldownable {
  cooldownSeconds: number;
  globalCooldownSeconds: number;
  perUserLastRun: Map<string, number>;
  lastGlobalRun: number;
}

interface RegisteredSubcommand extends Cooldownable {
  name: string;
  description: string;
  usage?: string;
  permission: PermissionLevel;
  handler: CommandHandler;
}

interface RegisteredCommand extends Required<Omit<CommandOptions, 'aliases' | 'description' | 'group' | 'usage'>> {
  name: string;
  handler: CommandHandler;
  description: string;
  usage?: string;
  group?: string;
  /** Present when registered via registerGroup. */
  subcommands?: Map<string, RegisteredSubcommand>;
  onUnknown?: CommandHandler;
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
  /** Group applied to subsequent register() calls (set by PluginManager per plugin). */
  private currentGroup: string | undefined;

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
      usage: options.usage,
      group: options.group ?? this.currentGroup,
      perUserLastRun: new Map(),
      lastGlobalRun: 0,
    };
    this.commands.set(key, cmd);
    for (const alias of options.aliases ?? []) {
      this.aliasIndex.set(alias.toLowerCase(), key);
    }
    log.debug({ command: key }, 'registered command');
  }

  /**
   * Register a primary command that dispatches to named subcommands
   * (`!name <sub> …`). Each subcommand is documented and enforces its own
   * permission + cooldowns. Calling the primary with no/invalid subcommand runs
   * `onUnknown` (default: print the description/usage).
   */
  registerGroup(name: string, options: GroupOptions): void {
    const key = name.toLowerCase();
    const defaultPerm = options.permission ?? PermissionLevel.Viewer;
    const subcommands = new Map<string, RegisteredSubcommand>();
    for (const [subName, spec] of Object.entries(options.subcommands)) {
      const registered: RegisteredSubcommand = {
        name: subName.toLowerCase(),
        description: spec.description ?? '',
        usage: spec.usage,
        permission: spec.permission ?? defaultPerm,
        cooldownSeconds: spec.cooldownSeconds ?? 0,
        globalCooldownSeconds: spec.globalCooldownSeconds ?? 0,
        handler: spec.handler,
        perUserLastRun: new Map(),
        lastGlobalRun: 0,
      };
      subcommands.set(registered.name, registered);
      // Aliases share the same object, so they resolve to one handler and one
      // cooldown, and `list()` can dedupe them by identity.
      for (const alias of spec.aliases ?? []) subcommands.set(alias.toLowerCase(), registered);
    }
    const cmd: RegisteredCommand = {
      name: key,
      handler: (e) => this.dispatchSubcommand(key, e),
      permission: defaultPerm,
      cooldownSeconds: 0,
      globalCooldownSeconds: 0,
      description: options.description ?? '',
      group: options.group ?? this.currentGroup,
      subcommands,
      onUnknown: options.onUnknown,
      perUserLastRun: new Map(),
      lastGlobalRun: 0,
    };
    this.commands.set(key, cmd);
    for (const alias of options.aliases ?? []) this.aliasIndex.set(alias.toLowerCase(), key);
    log.debug({ command: key, subcommands: subcommands.size }, 'registered command group');
  }

  private async dispatchSubcommand(primaryKey: string, e: CommandEvent): Promise<void> {
    const cmd = this.commands.get(primaryKey);
    if (!cmd?.subcommands) return;
    const subName = e.args[0]?.toLowerCase();
    const sub = subName ? cmd.subcommands.get(subName) : undefined;

    if (!sub) {
      if (cmd.onUnknown) return void cmd.onUnknown(e);
      const primaries = [...new Set([...cmd.subcommands.values()].map((s) => s.name))];
      const usage = cmd.description || `Usage: !${cmd.name} <${primaries.join('|')}>`;
      await this.chat.say(e.channel, usage);
      return;
    }
    if (!this.checkPermission(e.user, sub.permission)) return;
    if (!this.checkCooldown(sub, e.user.id)) return;

    // Hand the subcommand its own view: the subcommand token stripped off.
    const firstSpace = e.argString.indexOf(' ');
    const rest = firstSpace === -1 ? '' : e.argString.slice(firstSpace + 1).trim();
    const derived: CommandEvent = { ...e, args: e.args.slice(1), argString: rest };
    await sub.handler(derived);
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

  /**
   * Whether `name` resolves to a registered (built-in) command or alias
   * (case-insensitive). Used to stop custom commands/aliases from shadowing a
   * built-in — the router resolves built-ins before the custom fallback, so such
   * a custom trigger could never fire.
   */
  isRegistered(name: string): boolean {
    const key = name.toLowerCase();
    return this.commands.has(key) || this.aliasIndex.has(key);
  }

  /**
   * Tag subsequent `register()` calls with a group (the registering plugin).
   * The PluginManager sets this around each plugin's init so the dashboard can
   * group built-in commands by plugin. Pass undefined to clear.
   */
  setCurrentGroup(group: string | undefined): void {
    this.currentGroup = group;
  }

  /**
   * List registered commands for help/introspection, including subcommands as
   * their own entries (`"wheel title"`) and each command's cooldowns.
   */
  list(): {
    name: string; description: string; usage?: string; permission: PermissionLevel; group?: string;
    globalCooldown: number; userCooldown: number;
  }[] {
    const out = [];
    for (const c of this.commands.values()) {
      out.push({
        name: c.name, description: c.description, usage: c.usage, permission: c.permission, group: c.group,
        globalCooldown: c.globalCooldownSeconds, userCooldown: c.cooldownSeconds,
      });
      if (c.subcommands) {
        // Aliases point at the same object as their primary; list each once.
        const seen = new Set<RegisteredSubcommand>();
        for (const s of c.subcommands.values()) {
          if (seen.has(s)) continue;
          seen.add(s);
          out.push({
            name: `${c.name} ${s.name}`, description: s.description, usage: s.usage, permission: s.permission, group: c.group,
            globalCooldown: s.globalCooldownSeconds, userCooldown: s.cooldownSeconds,
          });
        }
      }
    }
    return out;
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

  private checkCooldown(cmd: Cooldownable, userId: string): boolean {
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
