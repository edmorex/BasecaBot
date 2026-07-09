import type { Storage } from './storage/index.js';
import { PermissionLevel } from '../core/events.js';

/** User-facing error (message is safe to show in chat / API responses). */
export class CommandError extends Error {}

export type CommandKind = 'trigger' | 'phrase';

/** A parsed command target: `!word` (trigger) or `"phrase"` (phrase). */
export interface TargetRef {
  kind: CommandKind;
  name: string;
}

/** Minimal shape used at runtime for matching + cooldown/permission checks. */
interface RuntimeCommand {
  id: number;
  kind: CommandKind;
  name: string;
  response: string | null;
  permission: number;
  globalCooldown: number;
  userCooldown: number;
  enabled: boolean;
}

/** `!command restrict` keyword <-> PermissionLevel. */
const RESTRICT_TO_LEVEL: Record<string, number> = {
  all: PermissionLevel.Viewer,
  sub: PermissionLevel.Subscriber,
  vip: PermissionLevel.Vip,
  mod: PermissionLevel.Moderator,
  broadcaster: PermissionLevel.Broadcaster,
  admin: PermissionLevel.Admin,
};

export function restrictKeywordToLevel(word: string): number | null {
  const lvl = RESTRICT_TO_LEVEL[word.trim().toLowerCase()];
  return lvl === undefined ? null : lvl;
}

export function normalizeWord(word: string): string {
  return word.trim().toLowerCase().replace(/^!/, '');
}

/**
 * Parse a target and the remaining text from an argument string. A target is
 * either a `!trigger` (single word) or a `"phrase"` (quoted). Returns the target
 * plus the leftover text (message / value), or null if no valid target.
 */
export function parseTarget(input: string): { target: TargetRef; rest: string } | null {
  const s = input.trimStart();
  if (s.startsWith('"')) {
    const end = s.indexOf('"', 1);
    if (end === -1) return null;
    const name = s.slice(1, end).trim();
    if (!name) return null;
    return { target: { kind: 'phrase', name }, rest: s.slice(end + 1).trim() };
  }
  if (s.startsWith('!')) {
    const m = /^!(\S+)\s*([\s\S]*)$/.exec(s);
    if (!m) return null;
    return { target: { kind: 'trigger', name: normalizeWord(m[1] ?? '') }, rest: (m[2] ?? '').trim() };
  }
  return null;
}

/**
 * Owns custom commands: CRUD (used by chat `!command` and the dashboard) plus
 * runtime matching. Trigger words are resolved via the CommandTrigger table;
 * phrases are matched against an in-memory cache (refreshed on every mutation)
 * so scanning each chat message doesn't hit the database. Cooldowns are tracked
 * in memory; usage counts are persisted.
 */
export class CustomCommandService {
  private phraseCache = new Map<string, RuntimeCommand[]>();
  private readonly lastGlobal = new Map<number, number>();
  private readonly lastUser = new Map<number, Map<string, number>>();

  constructor(private readonly storage: Storage) {}

  private get db() {
    return this.storage.prisma;
  }

  /** Load the phrase cache. Call once at startup. */
  async init(): Promise<void> {
    await this.reloadPhrases();
  }

  private async reloadPhrases(): Promise<void> {
    const rows = await this.db.customCommand.findMany({ where: { kind: 'phrase', enabled: true } });
    const byChannel = new Map<string, RuntimeCommand[]>();
    for (const r of rows) {
      const list = byChannel.get(r.channel) ?? [];
      list.push(this.toRuntime(r));
      byChannel.set(r.channel, list);
    }
    this.phraseCache = byChannel;
  }

  private toRuntime(r: {
    id: number; kind: string; name: string; response: string | null;
    permission: number; globalCooldown: number; userCooldown: number; enabled: boolean;
  }): RuntimeCommand {
    return {
      id: r.id, kind: r.kind as CommandKind, name: r.name, response: r.response,
      permission: r.permission, globalCooldown: r.globalCooldown, userCooldown: r.userCooldown, enabled: r.enabled,
    };
  }

  // ── Runtime matching ────────────────────────────────────────────────────────

  /** Resolve a `!word` (primary or alias) to its command, or null. */
  async findByTrigger(channel: string, word: string): Promise<RuntimeCommand | null> {
    const trigger = await this.db.commandTrigger.findUnique({
      where: { channel_word: { channel, word: normalizeWord(word) } },
      include: { command: true },
    });
    return trigger ? this.toRuntime(trigger.command) : null;
  }

  /** Enabled phrase commands whose text appears in `message` (case-insensitive). */
  matchPhrases(channel: string, message: string): RuntimeCommand[] {
    const list = this.phraseCache.get(channel);
    if (!list?.length) return [];
    const lower = message.toLowerCase();
    return list.filter((c) => lower.includes(c.name.toLowerCase()));
  }

  /** Whether a command may fire now for this user (enabled + permission + cooldowns). */
  canTrigger(cmd: RuntimeCommand, userId: string, userPermission: number, now = Date.now()): boolean {
    if (!cmd.enabled) return false;
    if (userPermission < cmd.permission) return false;
    if (cmd.globalCooldown > 0 && now - (this.lastGlobal.get(cmd.id) ?? 0) < cmd.globalCooldown * 1000) return false;
    if (cmd.userCooldown > 0) {
      const last = this.lastUser.get(cmd.id)?.get(userId) ?? 0;
      if (now - last < cmd.userCooldown * 1000) return false;
    }
    return true;
  }

  /** Record a fire: bump cooldown clocks and persist the usage count. */
  recordUse(cmd: RuntimeCommand, userId: string, now = Date.now()): void {
    this.lastGlobal.set(cmd.id, now);
    let um = this.lastUser.get(cmd.id);
    if (!um) this.lastUser.set(cmd.id, (um = new Map()));
    um.set(userId, now);
    void this.db.customCommand.update({ where: { id: cmd.id }, data: { usageCount: { increment: 1 } } }).catch(() => {});
  }

  // ── CRUD (used by `!command` and the dashboard) ──────────────────────────────

  /** Fetch the full command row for a target, or null. */
  async resolve(channel: string, target: TargetRef) {
    if (target.kind === 'trigger') {
      const t = await this.db.commandTrigger.findUnique({
        where: { channel_word: { channel, word: normalizeWord(target.name) } },
        include: { command: { include: { triggers: true } } },
      });
      return t?.command ?? null;
    }
    return this.db.customCommand.findUnique({
      where: { channel_kind_name: { channel, kind: 'phrase', name: target.name } },
      include: { triggers: true },
    });
  }

  private async resolveOrThrow(channel: string, target: TargetRef) {
    const cmd = await this.resolve(channel, target);
    if (!cmd) throw new CommandError(`No command ${describeTarget(target)} found.`);
    return cmd;
  }

  async create(
    channel: string,
    target: TargetRef,
    opts: { response?: string | null; permission?: number; globalCooldown?: number; userCooldown?: number } = {},
  ) {
    const name = target.kind === 'trigger' ? normalizeWord(target.name) : target.name.trim();
    if (!name) throw new CommandError('Command name/phrase cannot be empty.');
    if (target.kind === 'trigger' && /\s/.test(name)) throw new CommandError('Trigger words cannot contain spaces.');

    if (await this.resolve(channel, { kind: target.kind, name })) {
      throw new CommandError(`A command ${describeTarget({ kind: target.kind, name })} already exists.`);
    }
    if (target.kind === 'trigger' && (await this.wordTaken(channel, name))) {
      throw new CommandError(`The trigger !${name} is already in use.`);
    }

    const { globalCooldown, userCooldown } = clampCooldowns(opts.globalCooldown ?? 0, opts.userCooldown ?? 0);
    const cmd = await this.db.customCommand.create({
      data: {
        channel, kind: target.kind, name,
        response: emptyToNull(opts.response),
        permission: clampLevel(opts.permission ?? 0),
        globalCooldown, userCooldown,
      },
    });
    if (target.kind === 'trigger') {
      await this.db.commandTrigger.create({ data: { channel, word: name, isPrimary: true, commandId: cmd.id } });
    }
    await this.reloadPhrases();
    return cmd;
  }

  async setResponse(channel: string, target: TargetRef, response: string | null) {
    const cmd = await this.resolveOrThrow(channel, target);
    await this.db.customCommand.update({ where: { id: cmd.id }, data: { response: emptyToNull(response) } });
    await this.reloadPhrases();
  }

  /** Set (or clear, when empty) the command's grouping label. */
  async setGroup(channel: string, target: TargetRef, group: string) {
    const cmd = await this.resolveOrThrow(channel, target);
    const value = group.trim();
    if (value.length > 30) throw new CommandError('Group name is too long (max 30).');
    await this.db.customCommand.update({ where: { id: cmd.id }, data: { group: value || null } });
  }

  async setPermission(channel: string, target: TargetRef, level: number) {
    const cmd = await this.resolveOrThrow(channel, target);
    await this.db.customCommand.update({ where: { id: cmd.id }, data: { permission: clampLevel(level) } });
    await this.reloadPhrases();
  }

  async setCooldown(channel: string, target: TargetRef, globalSecs: number, userSecs?: number) {
    const cmd = await this.resolveOrThrow(channel, target);
    const { globalCooldown, userCooldown } = clampCooldowns(globalSecs, userSecs ?? cmd.userCooldown);
    await this.db.customCommand.update({ where: { id: cmd.id }, data: { globalCooldown, userCooldown } });
    await this.reloadPhrases();
  }

  async setEnabled(channel: string, target: TargetRef, enabled: boolean) {
    const cmd = await this.resolveOrThrow(channel, target);
    await this.db.customCommand.update({ where: { id: cmd.id }, data: { enabled } });
    await this.reloadPhrases();
  }

  async setUsageCount(channel: string, target: TargetRef, count: number) {
    const cmd = await this.resolveOrThrow(channel, target);
    await this.db.customCommand.update({ where: { id: cmd.id }, data: { usageCount: Math.max(0, Math.floor(count)) } });
  }

  async remove(channel: string, target: TargetRef) {
    const cmd = await this.resolveOrThrow(channel, target);
    await this.db.customCommand.delete({ where: { id: cmd.id } }); // cascades triggers
    await this.reloadPhrases();
  }

  async addAlias(channel: string, target: TargetRef, aliasWord: string) {
    const cmd = await this.resolveOrThrow(channel, target);
    if (cmd.kind !== 'trigger') throw new CommandError('Only trigger commands can have aliases.');
    const word = normalizeWord(aliasWord);
    if (!word || /\s/.test(word)) throw new CommandError('An alias must be a single word.');
    if (await this.wordTaken(channel, word)) throw new CommandError(`The trigger !${word} is already in use.`);
    await this.db.commandTrigger.create({ data: { channel, word, isPrimary: false, commandId: cmd.id } });
  }

  async removeAlias(channel: string, target: TargetRef, aliasWord: string) {
    const cmd = await this.resolveOrThrow(channel, target);
    const word = normalizeWord(aliasWord);
    const trigger = await this.db.commandTrigger.findUnique({ where: { channel_word: { channel, word } } });
    if (!trigger || trigger.commandId !== cmd.id) throw new CommandError(`!${word} is not an alias of that command.`);
    if (trigger.isPrimary) throw new CommandError('Cannot remove the primary trigger; remove the command instead.');
    await this.db.commandTrigger.delete({ where: { id: trigger.id } });
  }

  private async wordTaken(channel: string, word: string): Promise<boolean> {
    return (await this.db.commandTrigger.findUnique({ where: { channel_word: { channel, word } } })) !== null;
  }

  /** All custom commands (with alias words) for the dashboard. */
  async listForDashboard(channel: string) {
    const rows = await this.db.customCommand.findMany({
      where: { channel },
      include: { triggers: { orderBy: { isPrimary: 'desc' } } },
      orderBy: { name: 'asc' },
    });
    return rows.map((r) => ({
      kind: r.kind as CommandKind,
      name: r.name,
      response: r.response,
      group: r.group,
      permission: r.permission,
      globalCooldown: r.globalCooldown,
      userCooldown: r.userCooldown,
      enabled: r.enabled,
      usageCount: r.usageCount,
      aliases: r.triggers.filter((t) => !t.isPrimary).map((t) => t.word),
    }));
  }
}

// ── helpers ────────────────────────────────────────────────────────────────

function emptyToNull(v: string | null | undefined): string | null {
  const t = (v ?? '').trim();
  return t.length ? t : null;
}

function clampLevel(level: number): number {
  return Math.min(PermissionLevel.Admin, Math.max(PermissionLevel.Viewer, Math.floor(level) || 0));
}

/** Enforce the invariant that user cooldown is never below global cooldown. */
function clampCooldowns(globalSecs: number, userSecs: number): { globalCooldown: number; userCooldown: number } {
  const globalCooldown = Math.max(0, Math.floor(globalSecs) || 0);
  const userCooldown = Math.max(globalCooldown, Math.max(0, Math.floor(userSecs) || 0));
  return { globalCooldown, userCooldown };
}

export function describeTarget(t: TargetRef): string {
  return t.kind === 'trigger' ? `!${t.name}` : `"${t.name}"`;
}
