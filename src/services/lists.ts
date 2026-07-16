import type { Storage } from './storage/index.js';
import { PermissionLevel } from '../core/events.js';

/** User-facing error (message is safe to show in chat / API responses). */
export class ListError extends Error {}

/** Who added a list/entry — id (for the FK) plus a snapshot of the display name. */
export interface Actor {
  id: string;
  displayName: string;
}

/** `!list restrict` keyword <-> PermissionLevel (mirrors custom commands). */
const RESTRICT_TO_LEVEL: Record<string, number> = {
  all: PermissionLevel.Viewer,
  sub: PermissionLevel.Subscriber,
  vip: PermissionLevel.Vip,
  mod: PermissionLevel.Moderator,
  broadcaster: PermissionLevel.Broadcaster,
  admin: PermissionLevel.Admin,
};

export function listRestrictKeywordToLevel(word: string): number | null {
  const lvl = RESTRICT_TO_LEVEL[word.trim().toLowerCase()];
  return lvl === undefined ? null : lvl;
}

/** Reference name: a single lowercased word, no leading '!'. */
export function normalizeListName(name: string): string {
  return name.trim().toLowerCase().replace(/^!/, '');
}

function clampLevel(level: number): number {
  return Math.min(PermissionLevel.Admin, Math.max(PermissionLevel.Viewer, Math.floor(level) || 0));
}

/** A list plus its entries, shaped for the dashboard / chat. */
export interface ListView {
  name: string;
  displayName: string | null;
  description: string | null;
  permission: number;
  createdByName: string | null;
  createdAt: string;
  entries: {
    id: number;
    text: string;
    addedByName: string | null;
    addedAt: string;
  }[];
}

/**
 * Owns named lists and their entries: CRUD used by the chat `!list` manager and
 * the dashboard. Lists are keyed by their normalized single-word `name`.
 * Metadata (creator, per-entry author, timestamps) is recorded so the dashboard
 * can show provenance.
 *
 * Callers that pass an `Actor` must ensure that user exists (UsersService.touch)
 * first — entries/lists reference User by foreign key.
 */
export class ListsService {
  constructor(private readonly storage: Storage) {}

  private get db() {
    return this.storage.prisma;
  }

  /** Resolve a list row (without entries) or throw a user-facing error. */
  private async resolveOrThrow(name: string) {
    const list = await this.db.list.findUnique({ where: { name: normalizeListName(name) } });
    if (!list) throw new ListError(`No list called "${normalizeListName(name)}" exists.`);
    return list;
  }

  async exists(name: string): Promise<boolean> {
    return (await this.db.list.findUnique({ where: { name: normalizeListName(name) } })) !== null;
  }

  /** The permission level required to add to a list (throws if the list is unknown). */
  async addPermission(name: string): Promise<number> {
    const list = await this.resolveOrThrow(name);
    return list.addPermission;
  }

  async create(rawName: string, displayName?: string, creator?: Actor) {
    const name = normalizeListName(rawName);
    if (!name) throw new ListError('A list name is required.');
    if (/\s/.test(name)) throw new ListError('A list name must be a single word.');
    if (name.length > 40) throw new ListError('List name is too long (max 40).');
    if (await this.exists(name)) throw new ListError(`A list called "${name}" already exists.`);
    const display = (displayName ?? '').trim();
    if (display.length > 80) throw new ListError('Display name is too long (max 80).');
    return this.db.list.create({
      data: {
        name,
        displayName: display || null,
        addPermission: PermissionLevel.Moderator,
        createdById: creator?.id ?? null,
        createdByName: creator?.displayName ?? null,
      },
    });
  }

  async setDisplayName(name: string, displayName: string): Promise<void> {
    const list = await this.resolveOrThrow(name);
    const display = displayName.trim();
    if (display.length > 80) throw new ListError('Display name is too long (max 80).');
    await this.db.list.update({ where: { id: list.id }, data: { displayName: display || null } });
  }

  async setDescription(name: string, description: string): Promise<void> {
    const list = await this.resolveOrThrow(name);
    const value = description.trim();
    if (value.length > 500) throw new ListError('Description is too long (max 500).');
    await this.db.list.update({ where: { id: list.id }, data: { description: value || null } });
  }

  async setPermission(name: string, level: number): Promise<void> {
    const list = await this.resolveOrThrow(name);
    await this.db.list.update({ where: { id: list.id }, data: { addPermission: clampLevel(level) } });
  }

  /** Rename a list's reference word (keeps entries + metadata). */
  async rename(name: string, rawNewName: string): Promise<void> {
    const list = await this.resolveOrThrow(name);
    const newName = normalizeListName(rawNewName);
    if (!newName) throw new ListError('A new list name is required.');
    if (/\s/.test(newName)) throw new ListError('A list name must be a single word.');
    if (newName.length > 40) throw new ListError('List name is too long (max 40).');
    if (newName === list.name) return;
    if (await this.exists(newName)) throw new ListError(`A list called "${newName}" already exists.`);
    await this.db.list.update({ where: { id: list.id }, data: { name: newName } });
  }

  /** Delete a list and all of its entries. */
  async remove(name: string): Promise<void> {
    const list = await this.resolveOrThrow(name);
    await this.db.list.delete({ where: { id: list.id } }); // cascades entries
  }

  /** Remove all entries but keep the list. Returns how many were cleared. */
  async clear(name: string): Promise<number> {
    const list = await this.resolveOrThrow(name);
    const { count } = await this.db.listEntry.deleteMany({ where: { listId: list.id } });
    return count;
  }

  async addEntry(name: string, rawText: string, actor?: Actor) {
    const list = await this.resolveOrThrow(name);
    const text = rawText.trim();
    if (!text) throw new ListError('Entry text cannot be empty.');
    if (text.length > 500) throw new ListError('Entry is too long (max 500).');
    return this.db.listEntry.create({
      data: {
        listId: list.id,
        text,
        addedById: actor?.id ?? null,
        addedByName: actor?.displayName ?? null,
      },
    });
  }

  async updateEntry(name: string, entryId: number, rawText: string): Promise<void> {
    const list = await this.resolveOrThrow(name);
    const text = rawText.trim();
    if (!text) throw new ListError('Entry text cannot be empty.');
    if (text.length > 500) throw new ListError('Entry is too long (max 500).');
    const { count } = await this.db.listEntry.updateMany({ where: { id: entryId, listId: list.id }, data: { text } });
    if (count === 0) throw new ListError('That entry no longer exists.');
  }

  async removeEntry(name: string, entryId: number): Promise<void> {
    const list = await this.resolveOrThrow(name);
    const { count } = await this.db.listEntry.deleteMany({ where: { id: entryId, listId: list.id } });
    if (count === 0) throw new ListError('That entry no longer exists.');
  }

  /** A random entry's text, or null if the list is empty. */
  async random(name: string): Promise<string | null> {
    const list = await this.resolveOrThrow(name);
    const count = await this.db.listEntry.count({ where: { listId: list.id } });
    if (count === 0) return null;
    const skip = Math.floor(Math.random() * count);
    const [entry] = await this.db.listEntry.findMany({ where: { listId: list.id }, orderBy: { id: 'asc' }, skip, take: 1 });
    return entry?.text ?? null;
  }

  /** A list's display name (falls back to its reference name), or null if unknown. Non-throwing — for $(list). */
  async displayNameOf(name: string): Promise<string | null> {
    const list = await this.db.list.findUnique({ where: { name: normalizeListName(name) } });
    return list ? (list.displayName?.trim() || list.name) : null;
  }

  /** The nth entry (1-based) of a list, or null if out of range / unknown. Non-throwing — for $(list.n). */
  async entryAt(name: string, n: number): Promise<string | null> {
    const list = await this.db.list.findUnique({ where: { name: normalizeListName(name) } });
    if (!list || !Number.isInteger(n) || n < 1) return null;
    const [entry] = await this.db.listEntry.findMany({ where: { listId: list.id }, orderBy: { id: 'asc' }, skip: n - 1, take: 1 });
    return entry?.text ?? null;
  }

  /** All list reference names (for the sidebar / help). */
  async listNames(): Promise<string[]> {
    const rows = await this.db.list.findMany({ orderBy: { name: 'asc' }, select: { name: true } });
    return rows.map((r) => r.name);
  }

  /** Every list with its entries, for the dashboard. */
  async listAllForDashboard(): Promise<ListView[]> {
    const rows = await this.db.list.findMany({
      orderBy: { name: 'asc' },
      include: { entries: { orderBy: { id: 'asc' } } },
    });
    return rows.map((r) => ({
      name: r.name,
      displayName: r.displayName,
      description: r.description,
      permission: r.addPermission,
      createdByName: r.createdByName,
      createdAt: r.createdAt.toISOString(),
      entries: r.entries.map((e) => ({
        id: e.id,
        text: e.text,
        addedByName: e.addedByName,
        addedAt: e.createdAt.toISOString(),
      })),
    }));
  }
}
