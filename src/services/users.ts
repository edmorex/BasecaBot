import type { Storage } from './storage/index.js';
import type { EventUser } from '../core/events.js';

/** Normalize a name for alias lookup/uniqueness: lowercase, strip a leading @. */
export function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/^@/, '');
}

export class AliasError extends Error {}

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
 * User persistence: remembers everyone the bot sees, keeps their Twitch-derived
 * fields current, and owns editable profile data (custom display name, aliases).
 */
export class UsersService {
  constructor(private readonly storage: Storage) {}

  /**
   * Get-or-create a user by Twitch id. Refreshes login, avatar, and last-seen.
   * The display name is synced from Twitch only until the user customizes it
   * (`displayNameLocked`), after which it is left untouched.
   */
  async touch(user: Pick<EventUser, 'id' | 'login' | 'displayName'> & { avatarUrl?: string | null }) {
    const now = new Date();
    const login = user.login.toLowerCase();
    const existing = await this.storage.prisma.user.findUnique({ where: { id: user.id } });

    if (!existing) {
      return this.storage.prisma.user.create({
        data: { id: user.id, login, displayName: user.displayName, avatarUrl: user.avatarUrl ?? null },
      });
    }
    return this.storage.prisma.user.update({
      where: { id: user.id },
      data: {
        login,
        lastSeenAt: now,
        ...(user.avatarUrl ? { avatarUrl: user.avatarUrl } : {}),
        ...(existing.displayNameLocked ? {} : { displayName: user.displayName }),
      },
    });
  }

  async getById(id: string) {
    return this.storage.prisma.user.findUnique({ where: { id } });
  }

  async getByLogin(login: string) {
    return this.storage.prisma.user.findUnique({ where: { login: login.toLowerCase() } });
  }

  /** Full profile (with aliases) for the dashboard, or null if unknown. */
  async getProfile(id: string): Promise<UserProfile | null> {
    const user = await this.storage.prisma.user.findUnique({
      where: { id },
      include: { aliases: { orderBy: { createdAt: 'asc' } } },
    });
    if (!user) return null;
    return {
      twitchId: user.id,
      login: user.login,
      canonical: `@${user.login}`,
      displayName: user.displayName,
      avatarUrl: user.avatarUrl,
      aliases: user.aliases.map((a) => a.alias),
    };
  }

  /** Set a custom display name and lock it against future Twitch syncs. */
  async setDisplayName(id: string, displayName: string): Promise<void> {
    const trimmed = displayName.trim();
    if (!trimmed) throw new AliasError('Display name cannot be empty.');
    if (trimmed.length > 40) throw new AliasError('Display name is too long (max 40).');
    await this.storage.prisma.user.update({
      where: { id },
      data: { displayName: trimmed, displayNameLocked: true },
    });
  }

  /** Add an alias for a user. Rejects blanks, collisions, and over-long values. */
  async addAlias(id: string, alias: string): Promise<void> {
    const display = alias.trim();
    const normalized = normalizeName(alias);
    if (!normalized) throw new AliasError('Alias cannot be empty.');
    if (display.length > 40) throw new AliasError('Alias is too long (max 40).');

    const existing = await this.storage.prisma.userAlias.findUnique({ where: { normalized } });
    if (existing) {
      throw new AliasError(existing.userId === id ? 'You already have that alias.' : 'That alias is already taken.');
    }
    await this.storage.prisma.userAlias.create({ data: { userId: id, alias: display, normalized } });
  }

  /** Remove one of the user's own aliases. */
  async removeAlias(id: string, alias: string): Promise<void> {
    const normalized = normalizeName(alias);
    await this.storage.prisma.userAlias.deleteMany({ where: { userId: id, normalized } });
  }

  /**
   * Resolve a name — canonical login, display name, or alias — to a user id.
   * The basis for future commands that reference people by any of their names.
   */
  async resolveNameToUserId(name: string): Promise<string | null> {
    const normalized = normalizeName(name);
    if (!normalized) return null;

    const byLogin = await this.storage.prisma.user.findUnique({ where: { login: normalized } });
    if (byLogin) return byLogin.id;

    const byAlias = await this.storage.prisma.userAlias.findUnique({ where: { normalized } });
    if (byAlias) return byAlias.userId;

    const byDisplay = await this.storage.prisma.user.findFirst({
      where: { displayName: { equals: name.trim() } },
    });
    return byDisplay?.id ?? null;
  }
}
