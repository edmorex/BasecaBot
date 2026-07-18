import type { Storage } from './storage/index.js';
import type { EventUser } from '../core/events.js';

/** Normalize a name for lookup/uniqueness: lowercase, strip a leading @. */
export function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/^@/, '');
}

/** Whether a Prisma error is a unique-constraint violation (P2002) on `field`. */
function isUniqueViolation(err: unknown, field: string): boolean {
  const e = err as { code?: string; meta?: { target?: string[] | string } } | null;
  if (e?.code !== 'P2002') return false;
  const target = e.meta?.target;
  const targets = Array.isArray(target) ? target : typeof target === 'string' ? [target] : [];
  return targets.includes(field);
}

export class AliasError extends Error {}

/**
 * Where an indexed name came from. Also its precedence when two users claim the
 * same name: a real Twitch account always outranks someone's chosen name.
 */
export type NameKind = 'login' | 'display' | 'alias';
const KIND_RANK: Record<NameKind, number> = { login: 3, display: 2, alias: 1 };
const MAX_NAME_LENGTH = 40;

/** How a name typed in a command resolved. */
export type UserRef =
  /** Matched a real user. Display using `displayName`. */
  | { kind: 'user'; id: string; login: string; displayName: string }
  /** Matched nobody, and wasn't written as an @handle — treat as free text. */
  | { kind: 'unlinked'; name: string }
  /** Written as `@handle` but no such Twitch account exists. Callers reject. */
  | { kind: 'unknown-handle'; name: string }
  /** Nothing was typed. */
  | { kind: 'empty' };

/**
 * Looks up a Twitch account by login, for `@handle`s the bot has never seen.
 * Injected (rather than importing the Twitch API here) so this service stays
 * testable offline; when absent, unknown handles simply don't resolve.
 */
export type TwitchUserLookup = (
  login: string,
) => Promise<{ id: string; login: string; displayName: string; avatarUrl?: string | null } | null>;

/** A user's profile as surfaced to the dashboard. */
export interface UserProfile {
  twitchId: string;
  login: string;
  /** Canonical username: "@" + login. */
  canonical: string;
  displayName: string;
  avatarUrl: string | null;
  aliases: string[];
}

/**
 * User persistence and identity. Remembers everyone the bot sees, keeps their
 * Twitch-derived fields current, owns editable profile data (custom display
 * name, aliases), and is the single authority for turning a name someone typed
 * into a user.
 *
 * Identity rests on one idea: every name a user can be referenced by — login,
 * custom display name, aliases — lives in ONE globally-unique index
 * (`UserName`). Because `normalized` is unique across all users and all kinds, a
 * typed name resolves to at most one person, so no display name or alias can
 * shadow another user's Twitch account. See docs/user-accounts.md.
 */
export class UsersService {
  constructor(
    private readonly storage: Storage,
    private readonly lookupTwitchUser?: TwitchUserLookup,
  ) {}

  private get db() {
    return this.storage.prisma;
  }

  /**
   * Get-or-create a user by Twitch id. Refreshes login, avatar, and last-seen,
   * and keeps their login in the name index.
   *
   * The display name is synced from Twitch only until the user customizes it
   * (`displayNameLocked`), after which the bot never overwrites it.
   *
   * Concurrency-safe: `touch` runs from several places at once for the same
   * message (the chat adapter fires one per message while a command handler may
   * await its own), so the write is an upsert rather than a read-then-create —
   * two racing calls for a brand-new user must not collide. If the unique `login`
   * is held by a DIFFERENT id (the user renamed on Twitch and someone else took
   * their old login) that stale login is released first, then the write retried.
   */
  async touch(user: Pick<EventUser, 'id' | 'login' | 'displayName'> & { avatarUrl?: string | null }) {
    const login = user.login.toLowerCase();
    let row;
    try {
      row = await this.upsertUser(user, login);
    } catch (err) {
      if (!isUniqueViolation(err, 'login')) throw err;
      // Another row owns this login. For a lost create race that row IS us (same
      // id) and releaseLogin is a no-op; for a rename it's a stale row we free.
      await this.releaseLogin(login, user.id);
      row = await this.upsertUser(user, login);
    }
    await this.syncLoginName(user.id, login);
    return row;
  }

  private async upsertUser(user: Pick<EventUser, 'id' | 'login' | 'displayName'> & { avatarUrl?: string | null }, login: string) {
    const existing = await this.db.user.findUnique({ where: { id: user.id } });
    const syncDisplayName = !existing?.displayNameLocked;
    return this.db.user.upsert({
      where: { id: user.id },
      create: { id: user.id, login, displayName: user.displayName, avatarUrl: user.avatarUrl ?? null },
      update: {
        login,
        lastSeenAt: new Date(),
        ...(user.avatarUrl ? { avatarUrl: user.avatarUrl } : {}),
        ...(syncDisplayName ? { displayName: user.displayName } : {}),
      },
    });
  }

  /**
   * Free a login currently held by a different user id, so `keepUserId` can take
   * it. The displaced row gets a placeholder containing ':' — impossible for a
   * real Twitch login — and self-heals to its true login the next time that user
   * is seen.
   */
  private async releaseLogin(login: string, keepUserId: string): Promise<void> {
    await this.db.user.updateMany({
      where: { login, id: { not: keepUserId } },
      data: { login: `${login}:renamed:${Date.now()}` },
    });
  }

  // ── name index ────────────────────────────────────────────────────────────────

  /**
   * Ensure `login` is indexed to this user, evicting whoever else held it.
   *
   * A real Twitch account unconditionally reclaims its own name: if someone had
   * squatted it as a display name or alias, or a stale row survived a rename,
   * that row loses. Runs on every touch, so it is deliberately a no-op cheap
   * path once the row is correct, and a failure here is logged-and-ignored
   * rather than failing the caller's command — the index self-heals next touch.
   */
  private async syncLoginName(userId: string, login: string): Promise<void> {
    if (login.includes(':')) return; // rename placeholder, not a real name
    try {
      const existing = await this.db.userName.findUnique({ where: { normalized: login } });
      if (existing?.userId === userId && existing.kind === 'login') {
        if (existing.name !== login) {
          await this.db.userName.update({ where: { id: existing.id }, data: { name: login } });
        }
      } else {
        if (existing) await this.db.userName.delete({ where: { id: existing.id } });
        await this.db.userName.create({ data: { userId, name: login, normalized: login, kind: 'login' } });
      }
      // A previous login row for this user means they renamed on Twitch.
      await this.db.userName.deleteMany({
        where: { userId, kind: 'login', normalized: { not: login } },
      });
    } catch {
      // Concurrent touches race on the unique `normalized`; the winner wrote the
      // same row we wanted, so there is nothing to repair.
    }
  }

  /**
   * Claim a name for a user, or throw if someone else holds it. Used by the
   * user-driven paths (display name, aliases) where a conflict must be reported
   * rather than resolved by force — only `syncLoginName` may evict.
   */
  private async claimName(userId: string, kind: NameKind, name: string): Promise<void> {
    const normalized = normalizeName(name);
    const existing = await this.db.userName.findUnique({ where: { normalized } });

    if (existing) {
      if (existing.userId !== userId) throw new AliasError(`"${name}" is already taken.`);
      if (existing.kind === kind) {
        if (existing.name !== name) await this.db.userName.update({ where: { id: existing.id }, data: { name } });
        return;
      }
      if (KIND_RANK[existing.kind as NameKind] > KIND_RANK[kind]) {
        throw new AliasError(`That is already your ${existing.kind === 'login' ? 'username' : 'display name'}.`);
      }
      // Promoting one of your own names (alias → display): reuse the row so the
      // name stays claimed throughout, with no window where it is free.
      await this.db.userName.update({ where: { id: existing.id }, data: { kind, name } });
      return;
    }

    try {
      await this.db.userName.create({ data: { userId, name, normalized, kind } });
    } catch (err) {
      if (isUniqueViolation(err, 'normalized')) throw new AliasError(`"${name}" is already taken.`);
      throw err;
    }
  }

  // ── reads ─────────────────────────────────────────────────────────────────────

  async getById(id: string) {
    return this.db.user.findUnique({ where: { id } });
  }

  async getByLogin(login: string) {
    return this.db.user.findUnique({ where: { login: login.toLowerCase() } });
  }

  /** Full profile (with aliases) for the dashboard, or null if unknown. */
  async getProfile(id: string): Promise<UserProfile | null> {
    const user = await this.db.user.findUnique({
      where: { id },
      include: { names: { where: { kind: 'alias' }, orderBy: { createdAt: 'asc' } } },
    });
    if (!user) return null;
    return {
      twitchId: user.id,
      login: user.login,
      canonical: `@${user.login}`,
      displayName: user.displayName,
      avatarUrl: user.avatarUrl,
      aliases: user.names.map((n) => n.name),
    };
  }

  // ── writes ────────────────────────────────────────────────────────────────────

  /**
   * Set a custom display name and lock it against future Twitch syncs. Indexed
   * so the name is reachable in commands — unless it normalizes to the user's own
   * login, which is already indexed and needs no second row.
   */
  async setDisplayName(id: string, displayName: string): Promise<void> {
    const trimmed = displayName.trim();
    if (!trimmed) throw new AliasError('Display name cannot be empty.');
    if (trimmed.length > MAX_NAME_LENGTH) throw new AliasError(`Display name is too long (max ${MAX_NAME_LENGTH}).`);

    const user = await this.db.user.findUnique({ where: { id } });
    if (!user) throw new AliasError('Unknown user.');

    const normalized = normalizeName(trimmed);
    if (normalized !== user.login) await this.claimName(id, 'display', trimmed);

    await this.db.user.update({ where: { id }, data: { displayName: trimmed, displayNameLocked: true } });
    // Drop any display row left over from a previous custom name.
    await this.db.userName.deleteMany({ where: { userId: id, kind: 'display', normalized: { not: normalized } } });
  }

  /** Add an alias for a user. Rejects blanks, collisions, and over-long values. */
  async addAlias(id: string, alias: string): Promise<void> {
    const display = alias.trim();
    const normalized = normalizeName(alias);
    if (!normalized) throw new AliasError('Alias cannot be empty.');
    if (display.length > MAX_NAME_LENGTH) throw new AliasError(`Alias is too long (max ${MAX_NAME_LENGTH}).`);
    await this.claimName(id, 'alias', display);
  }

  /** Remove one of the user's own aliases. */
  async removeAlias(id: string, alias: string): Promise<void> {
    await this.db.userName.deleteMany({ where: { userId: id, kind: 'alias', normalized: normalizeName(alias) } });
  }

  // ── resolution ────────────────────────────────────────────────────────────────

  /**
   * Turn a name someone typed into a user. The single entry point for every
   * command that takes a username.
   *
   * A bare `name` may be any indexed name — login, custom display name, or alias
   * — and resolves to at most one person because the index is globally unique.
   * If it matches nobody it is `unlinked`: valid free text (a guest, "chat"),
   * which callers may snapshot rather than reject.
   *
   * An `@handle` asserts a real Twitch account, so only a login counts. If the
   * bot has never seen it, it is looked up on Twitch and recorded on the spot —
   * otherwise `@someone` would fail for anyone who has never chatted. Only a
   * genuinely nonexistent account yields `unknown-handle`.
   */
  async resolveUserRef(input: string): Promise<UserRef> {
    const raw = input.trim();
    const normalized = normalizeName(raw);
    if (!normalized) return { kind: 'empty' };
    const isHandle = raw.startsWith('@');

    const row = await this.db.userName.findUnique({ where: { normalized }, include: { user: true } });

    if (!isHandle) {
      return row ? this.toRef(row.user) : { kind: 'unlinked', name: raw };
    }

    if (row?.kind === 'login') return this.toRef(row.user);

    const fetched = await this.lookupTwitchUser?.(normalized).catch(() => null);
    if (!fetched) return { kind: 'unknown-handle', name: normalized };
    // Recording the account also reclaims the name if it was squatted as an
    // alias or display name — logins always win.
    return this.toRef(await this.touch(fetched));
  }

  private toRef(user: { id: string; login: string; displayName: string }): UserRef {
    return { kind: 'user', id: user.id, login: user.login, displayName: user.displayName };
  }

  /**
   * Resolve a name to a user id, or null. Convenience wrapper over
   * `resolveUserRef` for callers that only need "who is this, if anyone".
   */
  async resolveNameToUserId(name: string): Promise<string | null> {
    const ref = await this.resolveUserRef(name);
    return ref.kind === 'user' ? ref.id : null;
  }
}
