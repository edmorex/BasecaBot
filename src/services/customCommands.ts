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

/** Outcome of `remove` — either a whole command (with the aliases it took) or a single alias. */
export type RemoveResult =
  | { type: 'command'; label: string; aliases: string[] }
  | { type: 'alias'; alias: string; command: string };

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
  usageCount: number;
}

/** The alias half of a trigger match (null when the word is the command's own trigger). */
export interface AliasInfo {
  word: string;
  /** Extra args to prepend to the caller's (may contain $() vars). */
  args: string;
  /** The alias's own enable flag. */
  enabled: boolean;
}

/** Result of resolving a `!word`: the target command plus alias info if it was an alias. */
export interface TriggerMatch {
  command: RuntimeCommand;
  alias: AliasInfo | null;
}

/** One row of a CSV import (a command/phrase, or an alias). */
export interface CommandImportItem {
  kind: 'trigger' | 'phrase' | 'alias';
  name: string;
  response?: string | null;
  group?: string | null;
  permission?: number;
  enabled?: boolean;
  globalCooldown?: number;
  userCooldown?: number;
  usageCount?: number;
  /** Alias only: target command word. */
  target?: string | null;
  /** Alias only: extra args. */
  args?: string | null;
  /** Command/phrase timestamps (ISO); honored on import. */
  createdAt?: string;
  updatedAt?: string;
}

/** One row of the dashboard command list: a command/phrase, or an alias mirroring its target. */
export interface DashboardRow {
  kind: CommandKind | 'alias';
  name: string;
  response: string | null;
  group: string | null;
  permission: number;
  globalCooldown: number;
  userCooldown: number;
  enabled: boolean;
  usageCount: number;
  /** Alias only: the command it points to. */
  target: string | null;
  /** Alias only: the extra args it prepends. */
  args: string | null;
  /** Command/phrase only (aliases have no timestamps). ISO strings or null. */
  createdAt: string | null;
  updatedAt: string | null;
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
  private phraseCache: RuntimeCommand[] = [];
  private readonly lastGlobal = new Map<number, number>();
  private readonly lastUser = new Map<number, Map<string, number>>();

  /** Whether a word is a reserved built-in command/alias. Injected from bootstrap. */
  private isReserved: (word: string) => boolean = () => false;

  constructor(private readonly storage: Storage) {}

  private get db() {
    return this.storage.prisma;
  }

  /** Provide the check that blocks trigger words colliding with built-in commands. */
  useReservedWords(isReserved: (word: string) => boolean): void {
    this.isReserved = isReserved;
  }

  /** Load the phrase cache. Call once at startup. */
  async init(): Promise<void> {
    await this.reloadPhrases();
  }

  private async reloadPhrases(): Promise<void> {
    const rows = await this.db.customCommand.findMany({ where: { kind: 'phrase', enabled: true } });
    this.phraseCache = rows.map((r) => this.toRuntime(r));
  }

  private toRuntime(r: {
    id: number; kind: string; name: string; response: string | null;
    permission: number; globalCooldown: number; userCooldown: number; enabled: boolean; usageCount: number;
  }): RuntimeCommand {
    return {
      id: r.id, kind: r.kind as CommandKind, name: r.name, response: r.response,
      permission: r.permission, globalCooldown: r.globalCooldown, userCooldown: r.userCooldown, enabled: r.enabled,
      usageCount: r.usageCount,
    };
  }

  // ── Runtime matching ────────────────────────────────────────────────────────

  /**
   * Resolve a `!word` to its target command plus alias info. `alias` is null when
   * the word is the command's own (primary) trigger; otherwise it carries the
   * alias's extra args + its independent enable flag.
   */
  async findByTrigger(word: string): Promise<TriggerMatch | null> {
    const trigger = await this.db.commandTrigger.findUnique({
      where: { word: normalizeWord(word) },
      include: { command: true },
    });
    if (!trigger) return null;
    return {
      command: this.toRuntime(trigger.command),
      alias: trigger.isPrimary ? null : { word: trigger.word, args: trigger.args ?? '', enabled: trigger.enabled },
    };
  }

  /** Enabled phrase commands whose text appears in `message` (case-insensitive). */
  matchPhrases(message: string): RuntimeCommand[] {
    if (!this.phraseCache.length) return [];
    const lower = message.toLowerCase();
    return this.phraseCache.filter((c) => lower.includes(c.name.toLowerCase()));
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

  /**
   * Record a fire: bump cooldown clocks and persist the usage count. Returns the
   * new usage count (the value $(count) shows), computed from the runtime row so
   * it's available synchronously even though the DB write is fire-and-forget.
   */
  recordUse(cmd: RuntimeCommand, userId: string, now = Date.now()): number {
    this.lastGlobal.set(cmd.id, now);
    let um = this.lastUser.get(cmd.id);
    if (!um) this.lastUser.set(cmd.id, (um = new Map()));
    um.set(userId, now);
    void this.db.customCommand.update({ where: { id: cmd.id }, data: { usageCount: { increment: 1 } } }).catch(() => {});
    return cmd.usageCount + 1;
  }

  /** The current usage count of a `!trigger`/phrase, for $(count !other). Null if unknown. */
  async getUsageCount(target: TargetRef): Promise<number | null> {
    const cmd = await this.resolve(target);
    return cmd ? cmd.usageCount : null;
  }

  // ── CRUD (used by `!command` and the dashboard) ──────────────────────────────

  /** Fetch the full command row for a target, or null. */
  async resolve(target: TargetRef) {
    if (target.kind === 'trigger') {
      const t = await this.db.commandTrigger.findUnique({
        where: { word: normalizeWord(target.name) },
        include: { command: { include: { triggers: true } } },
      });
      return t?.command ?? null;
    }
    return this.db.customCommand.findUnique({
      where: { kind_name: { kind: 'phrase', name: target.name } },
      include: { triggers: true },
    });
  }

  private async resolveOrThrow(target: TargetRef) {
    const cmd = await this.resolve(target);
    if (!cmd) throw new CommandError(`No command ${describeTarget(target)} found.`);
    return cmd;
  }

  async create(
    target: TargetRef,
    opts: { response?: string | null; permission?: number; globalCooldown?: number; userCooldown?: number } = {},
  ) {
    const name = target.kind === 'trigger' ? normalizeWord(target.name) : target.name.trim();
    if (!name) throw new CommandError('Command name/phrase cannot be empty.');
    if (target.kind === 'trigger' && /\s/.test(name)) throw new CommandError('Trigger words cannot contain spaces.');
    if (target.kind === 'trigger' && this.isReserved(name)) {
      throw new CommandError(`!${name} is a built-in command and can't be a custom command.`);
    }

    if (await this.resolve({ kind: target.kind, name })) {
      throw new CommandError(`A command ${describeTarget({ kind: target.kind, name })} already exists.`);
    }
    if (target.kind === 'trigger' && (await this.wordTaken(name))) {
      throw new CommandError(`The trigger !${name} is already in use.`);
    }

    const { globalCooldown, userCooldown } = clampCooldowns(opts.globalCooldown ?? 0, opts.userCooldown ?? 0);
    const cmd = await this.db.customCommand.create({
      data: {
        kind: target.kind, name,
        response: emptyToNull(opts.response),
        permission: clampLevel(opts.permission ?? 0),
        globalCooldown, userCooldown,
      },
    });
    if (target.kind === 'trigger') {
      await this.db.commandTrigger.create({ data: { word: name, isPrimary: true, commandId: cmd.id } });
    }
    await this.reloadPhrases();
    return cmd;
  }

  async setResponse(target: TargetRef, response: string | null) {
    const cmd = await this.resolveOrThrow(target);
    await this.db.customCommand.update({ where: { id: cmd.id }, data: { response: emptyToNull(response) } });
    await this.reloadPhrases();
  }

  /** Set (or clear, when empty) the command's grouping label. */
  async setGroup(target: TargetRef, group: string) {
    const cmd = await this.resolveOrThrow(target);
    const value = group.trim();
    if (value.length > 30) throw new CommandError('Group name is too long (max 30).');
    await this.db.customCommand.update({ where: { id: cmd.id }, data: { group: value || null } });
  }

  async setPermission(target: TargetRef, level: number) {
    const cmd = await this.resolveOrThrow(target);
    await this.db.customCommand.update({ where: { id: cmd.id }, data: { permission: clampLevel(level) } });
    await this.reloadPhrases();
  }

  async setCooldown(target: TargetRef, globalSecs: number, userSecs?: number) {
    const cmd = await this.resolveOrThrow(target);
    const { globalCooldown, userCooldown } = clampCooldowns(globalSecs, userSecs ?? cmd.userCooldown);
    await this.db.customCommand.update({ where: { id: cmd.id }, data: { globalCooldown, userCooldown } });
    await this.reloadPhrases();
  }

  /**
   * Enable/disable a command OR an alias. If the target word is an alias, only
   * that alias's flag is toggled (the command is untouched); otherwise the
   * command's flag is toggled.
   */
  async setEnabled(target: TargetRef, enabled: boolean) {
    if (target.kind === 'trigger') {
      const t = await this.db.commandTrigger.findUnique({ where: { word: normalizeWord(target.name) } });
      if (t && !t.isPrimary) {
        await this.db.commandTrigger.update({ where: { id: t.id }, data: { enabled } });
        return;
      }
    }
    const cmd = await this.resolveOrThrow(target);
    await this.db.customCommand.update({ where: { id: cmd.id }, data: { enabled } });
    await this.reloadPhrases();
  }

  async setUsageCount(target: TargetRef, count: number) {
    const cmd = await this.resolveOrThrow(target);
    await this.db.customCommand.update({ where: { id: cmd.id }, data: { usageCount: Math.max(0, Math.floor(count)) } });
  }

  /**
   * Remove a command or a single alias.
   *  - Trigger word that is an **alias** -> removes just that alias.
   *  - Trigger word that is the **primary** (or a phrase) -> removes the whole
   *    command and all its aliases (returned so the caller can report them).
   */
  async remove(target: TargetRef): Promise<RemoveResult> {
    if (target.kind === 'trigger') {
      const word = normalizeWord(target.name);
      const trigger = await this.db.commandTrigger.findUnique({
        where: { word },
        include: { command: { include: { triggers: true } } },
      });
      if (!trigger) throw new CommandError(`No command !${word} found.`);
      if (!trigger.isPrimary) {
        await this.db.commandTrigger.delete({ where: { id: trigger.id } });
        return { type: 'alias', alias: `!${word}`, command: `!${trigger.command.name}` };
      }
      const aliases = trigger.command.triggers.filter((t) => !t.isPrimary).map((t) => `!${t.word}`);
      await this.db.customCommand.delete({ where: { id: trigger.command.id } }); // cascades triggers
      await this.reloadPhrases();
      return { type: 'command', label: `!${trigger.command.name}`, aliases };
    }
    const cmd = await this.resolveOrThrow(target);
    await this.db.customCommand.delete({ where: { id: cmd.id } });
    await this.reloadPhrases();
    return { type: 'command', label: describeTarget(target), aliases: [] };
  }

  /** Resolve a word to the PRIMARY (root) command it triggers, or throw. Aliases rejected. */
  private async primaryCommandForWord(targetWord: string) {
    const word = normalizeWord(targetWord);
    if (!word) throw new CommandError('Provide the command to alias like !command.');
    const t = await this.db.commandTrigger.findUnique({ where: { word }, include: { command: true } });
    if (!t) throw new CommandError(`No command !${word} found to alias.`);
    if (!t.isPrimary) throw new CommandError(`!${word} is itself an alias — an alias must point to a command.`);
    return t.command;
  }

  /**
   * Create an alias `!alias` that runs `!target`, optionally prepending `args`
   * (which may contain $() variables resolved at call time). The target must be a
   * root trigger command, not another alias.
   */
  async addAlias(aliasWord: string, targetWord: string, args?: string | null) {
    const word = normalizeWord(aliasWord);
    if (!word || /\s/.test(word)) throw new CommandError('An alias must be a single word.');
    if (this.isReserved(word)) throw new CommandError(`!${word} is a built-in command and can't be used as an alias.`);
    if (await this.wordTaken(word)) throw new CommandError(`The trigger !${word} is already in use.`);
    const command = await this.primaryCommandForWord(targetWord);
    await this.db.commandTrigger.create({ data: { word, isPrimary: false, args: emptyToNull(args), enabled: true, commandId: command.id } });
  }

  /** Edit an alias: repoint it (`targetWord`), change its `args`, and/or toggle `enabled`. */
  async updateAlias(aliasWord: string, opts: { targetWord?: string; args?: string | null; enabled?: boolean }) {
    const word = normalizeWord(aliasWord);
    const t = await this.db.commandTrigger.findUnique({ where: { word } });
    if (!t) throw new CommandError(`No alias !${word} found.`);
    if (t.isPrimary) throw new CommandError(`!${word} is a command, not an alias.`);
    const data: { commandId?: number; args?: string | null; enabled?: boolean } = {};
    if (opts.targetWord !== undefined) data.commandId = (await this.primaryCommandForWord(opts.targetWord)).id;
    if (opts.args !== undefined) data.args = emptyToNull(opts.args);
    if (opts.enabled !== undefined) data.enabled = opts.enabled;
    await this.db.commandTrigger.update({ where: { id: t.id }, data });
  }

  /** Remove a single alias by its word (must be a non-primary alias, not a command). */
  async removeAlias(aliasWord: string) {
    const word = normalizeWord(aliasWord);
    const trigger = await this.db.commandTrigger.findUnique({ where: { word } });
    if (!trigger) throw new CommandError(`No alias !${word} found.`);
    if (trigger.isPrimary) throw new CommandError(`!${word} is a primary command, not an alias.`);
    await this.db.commandTrigger.delete({ where: { id: trigger.id } });
  }

  private async wordTaken(word: string): Promise<boolean> {
    return (await this.db.commandTrigger.findUnique({ where: { word } })) !== null;
  }

  /**
   * Flat list for the dashboard: one row per command/phrase, plus one row per
   * alias. Alias rows mirror their target's access/group/cooldown/usage and carry
   * the target name + extra args; their `enabled` is the alias's own flag.
   */
  async listForDashboard(): Promise<DashboardRow[]> {
    const rows = await this.db.customCommand.findMany({
      include: { triggers: true },
      orderBy: { name: 'asc' },
    });
    const out: DashboardRow[] = [];
    for (const r of rows) {
      out.push({
        kind: r.kind as CommandKind,
        name: r.name,
        response: r.response,
        group: r.group,
        permission: r.permission,
        globalCooldown: r.globalCooldown,
        userCooldown: r.userCooldown,
        enabled: r.enabled,
        usageCount: r.usageCount,
        target: null,
        args: null,
        createdAt: r.createdAt.toISOString(),
        updatedAt: r.updatedAt.toISOString(),
      });
      for (const t of r.triggers) {
        if (t.isPrimary) continue;
        out.push({
          kind: 'alias',
          name: t.word,
          response: null,
          group: r.group, // mirrored
          permission: r.permission, // mirrored
          globalCooldown: r.globalCooldown, // mirrored
          userCooldown: r.userCooldown, // mirrored
          enabled: t.enabled, // alias's own flag
          usageCount: r.usageCount, // mirrored
          target: r.name,
          args: t.args,
          createdAt: null, // aliases have no timestamps
          updatedAt: null,
        });
      }
    }
    return out;
  }

  /**
   * Import commands/aliases from CSV rows. `replace` first wipes all custom
   * commands; `add` keeps existing ones and skips conflicts. Commands are created
   * before aliases (aliases reference commands). Per-row errors (duplicates,
   * reserved words, missing alias targets) are skipped, not fatal. Returns counts.
   */
  async importCommands(items: CommandImportItem[], mode: 'add' | 'replace'): Promise<{ commands: number; aliases: number; skipped: number }> {
    if (mode === 'replace') await this.db.customCommand.deleteMany({}); // cascades triggers/aliases
    let commands = 0;
    let aliases = 0;
    let skipped = 0;

    // Phase 1: commands + phrases (so alias targets exist in phase 2).
    for (const it of items) {
      if (it.kind === 'alias') continue;
      const t: TargetRef = { kind: it.kind, name: it.name };
      try {
        const cmd = await this.create(t, { response: it.response ?? null, permission: it.permission, globalCooldown: it.globalCooldown, userCooldown: it.userCooldown });
        if (it.group) await this.setGroup(t, it.group);
        if (it.enabled === false) await this.setEnabled(t, false);
        if (it.usageCount) await this.setUsageCount(t, it.usageCount);
        // Restore timestamps LAST via raw SQL — the setGroup/setEnabled/setUsageCount
        // updates above bump updatedAt (@updatedAt), and raw SQL bypasses that.
        const cAt = parseTimestamp(it.createdAt);
        const uAt = parseTimestamp(it.updatedAt);
        if (cAt && uAt) await this.db.$executeRaw`UPDATE "CustomCommand" SET "createdAt" = ${cAt}, "updatedAt" = ${uAt} WHERE "id" = ${cmd.id}`;
        else if (cAt) await this.db.$executeRaw`UPDATE "CustomCommand" SET "createdAt" = ${cAt} WHERE "id" = ${cmd.id}`;
        else if (uAt) await this.db.$executeRaw`UPDATE "CustomCommand" SET "updatedAt" = ${uAt} WHERE "id" = ${cmd.id}`;
        commands++;
      } catch (e) {
        if (e instanceof CommandError) skipped++;
        else throw e;
      }
    }

    // Phase 2: aliases.
    for (const it of items) {
      if (it.kind !== 'alias') continue;
      try {
        await this.addAlias(it.name, it.target ?? '', it.args ?? null);
        if (it.enabled === false) await this.updateAlias(it.name, { enabled: false });
        aliases++;
      } catch (e) {
        if (e instanceof CommandError) skipped++;
        else throw e;
      }
    }

    await this.reloadPhrases();
    return { commands, aliases, skipped };
  }
}

// ── helpers ────────────────────────────────────────────────────────────────

function emptyToNull(v: string | null | undefined): string | null {
  const t = (v ?? '').trim();
  return t.length ? t : null;
}

/** Parse an ISO datetime string to a Date, or null if empty/invalid. */
function parseTimestamp(s: string | null | undefined): Date | null {
  if (!s || !s.trim()) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
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
