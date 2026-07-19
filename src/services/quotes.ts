import type { Storage } from './storage/index.js';
import type { UsersService } from './users.js';

/** User-facing error (message is safe to show in chat / API responses). */
export class QuoteError extends Error {}

/**
 * Pull the live display names of both people attached to a quote — who was
 * quoted, and who added it — so either can be rendered current rather than from
 * the stored snapshot.
 */
const WITH_QUOTED_USER = {
  quotedUserRef: { select: { displayName: true } },
  creator: { select: { displayName: true } },
} as const;

/** Who added a quote — id (for the FK) plus a snapshot of the display name. */
export interface Actor {
  id: string;
  displayName: string;
}

/** One row of a CSV import. */
export interface QuoteImportItem {
  /** Quote number; preserved on a full (replace) restore. */
  id?: string | number;
  text: string;
  user: string;
  game?: string | null;
  date?: string;
  quotedByName?: string | null;
  /** Twitch user id of who added it; restored only if that user still exists. */
  quotedById?: string | null;
  /** Twitch user id of the person quoted; restored only if that user still exists. */
  userId?: string | null;
  /** Row creation timestamp (ISO); honored on import. */
  createdAt?: string;
}

/** Parse an ISO datetime string to a Date, or null if empty/invalid. */
function parseTimestamp(s: string | null | undefined): Date | null {
  if (!s || !s.trim()) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** A quote as surfaced to the dashboard / chat formatting. */
export interface QuoteView {
  id: number;
  text: string;
  /**
   * Who was quoted, ready to display: the linked user's CURRENT display name, so
   * renames flow through to old quotes. Falls back to the stored snapshot when
   * the quote isn't linked to a Twitch account.
   */
  user: string;
  /** Twitch user id of the person quoted, or null if unlinked. */
  userId: string | null;
  game: string | null;
  date: string; // "YYYY-MM-DD"
  /**
   * Who added the quote, ready to display — the adder's CURRENT display name,
   * falling back to the snapshot taken when it was added.
   */
  quotedByName: string | null;
  quotedById: string | null;
  createdAt: string;
}

/** Strip a leading '@' and surrounding whitespace from a username. */
export function normalizeUser(name: string): string {
  return name.trim().replace(/^@/, '');
}

/**
 * Parse a loosely-formatted date ("YYYY MM DD", "YYYY/MM/DD", "YYYY-MM-DD") into
 * a canonical "YYYY-MM-DD" string, or null if it isn't a valid calendar date.
 */
export function parseQuoteDate(input: string): string | null {
  const parts = input.trim().split(/[^0-9]+/).filter(Boolean);
  if (parts.length !== 3) return null;
  const [y, m, d] = parts.map((n) => Number.parseInt(n, 10));
  if (!y || !m || !d) return null;
  if (String(y).length !== 4 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const iso = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const parsed = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.getUTCDate() !== d) return null; // rejects e.g. 2024-02-31
  return iso;
}

/** Today's date as "YYYY-MM-DD" (UTC). */
export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Format a quote for chat: `Quote 5: "text" - Name [Game] [2024/01/02]`.
 *
 * No '@' prefix: the name shown is a display name, which often differs from the
 * Twitch login, so "@Name" would imply a handle that may not exist.
 */
export function formatQuote(q: QuoteView): string {
  const game = q.game && q.game.trim() ? ` [${q.game.trim()}]` : '';
  const date = q.date ? ` [${q.date.replace(/-/g, '/')}]` : '';
  return `Quote ${q.id}: "${q.text}" - ${q.user}${game}${date}`;
}

/**
 * Owns quotes: CRUD used by the chat `!quote` manager and the dashboard, plus
 * the random/search lookups. `id` is the public quote number. Callers that pass
 * an `Actor` must ensure that user exists (UsersService.touch) first — quotes
 * reference User by foreign key.
 */
export class QuotesService {
  /**
   * `users` is optional so the service can be constructed without the identity
   * layer (unit tests); without it names are stored as typed and never linked.
   */
  constructor(
    private readonly storage: Storage,
    private readonly users?: UsersService,
  ) {}

  private get db() {
    return this.storage.prisma;
  }

  private toView = (q: {
    id: number; text: string; quotedUser: string; quotedUserId: string | null; game: string | null; quoteDate: string; createdByName: string | null; createdById: string | null; createdAt: Date;
    quotedUserRef?: { displayName: string } | null;
    creator?: { displayName: string } | null;
  }): QuoteView => ({
    id: q.id,
    text: q.text,
    // Both names render from the linked account when there is one, so they track
    // renames; the stored snapshot is only a fallback for unlinked rows.
    user: q.quotedUserRef?.displayName ?? q.quotedUser,
    userId: q.quotedUserId,
    game: q.game,
    date: q.quoteDate,
    quotedByName: q.creator?.displayName ?? q.createdByName,
    quotedById: q.createdById,
    createdAt: q.createdAt.toISOString(),
  });

  /**
   * Turn the name someone typed into who to attribute the quote to.
   *
   * A name that matches nobody is kept as free text — quotes are routinely
   * attributed to guests, callers, or "chat" — but an explicit `@handle` that
   * exists on neither our records nor Twitch is a typo worth reporting.
   */
  private async resolveQuoted(input: string): Promise<{ name: string; id: string | null }> {
    const typed = normalizeUser(input);
    if (!typed) throw new QuoteError('Provide the username being quoted.');
    if (!this.users) return { name: typed, id: null };

    const ref = await this.users.resolveUserRef(input);
    switch (ref.kind) {
      case 'user':
        return { name: ref.displayName, id: ref.id };
      case 'unknown-handle':
        throw new QuoteError(`There's no Twitch account called @${ref.name}.`);
      default:
        return { name: typed, id: null };
    }
  }

  private async resolveOrThrow(id: number) {
    if (!Number.isInteger(id) || id <= 0) throw new QuoteError('Provide a numeric quote ID.');
    const quote = await this.db.quote.findUnique({ where: { id }, include: WITH_QUOTED_USER });
    if (!quote) throw new QuoteError(`No quote found with ID ${id}.`);
    return quote;
  }

  async add(
    data: { user: string; text: string; game?: string | null; date?: string },
    creator?: Actor,
  ): Promise<QuoteView> {
    const quoted = await this.resolveQuoted(data.user);
    const text = data.text.trim();
    if (!text) throw new QuoteError('Provide the quote text.');
    if (text.length > 500) throw new QuoteError('Quote is too long (max 500).');
    const date = data.date ?? todayIso();
    const quote = await this.db.quote.create({
      data: {
        text,
        quotedUser: quoted.name,
        quotedUserId: quoted.id,
        game: (data.game ?? '').trim() || null,
        quoteDate: date,
        createdById: creator?.id ?? null,
        createdByName: creator?.displayName ?? null,
      },
      include: WITH_QUOTED_USER,
    });
    return this.toView(quote);
  }

  async getById(id: number): Promise<QuoteView> {
    return this.toView(await this.resolveOrThrow(id));
  }

  async remove(id: number): Promise<void> {
    await this.resolveOrThrow(id);
    await this.db.quote.delete({ where: { id } });
  }

  async setText(id: number, text: string): Promise<QuoteView> {
    await this.resolveOrThrow(id);
    const value = text.trim();
    if (!value) throw new QuoteError('Quote text cannot be empty.');
    if (value.length > 500) throw new QuoteError('Quote is too long (max 500).');
    return this.toView(await this.db.quote.update({ where: { id }, data: { text: value }, include: WITH_QUOTED_USER }));
  }

  async setUser(id: number, user: string): Promise<QuoteView> {
    await this.resolveOrThrow(id);
    const quoted = await this.resolveQuoted(user);
    return this.toView(
      await this.db.quote.update({
        where: { id },
        data: { quotedUser: quoted.name, quotedUserId: quoted.id },
        include: WITH_QUOTED_USER,
      }),
    );
  }

  async setGame(id: number, game: string): Promise<QuoteView> {
    await this.resolveOrThrow(id);
    return this.toView(await this.db.quote.update({ where: { id }, data: { game: game.trim() || null }, include: WITH_QUOTED_USER }));
  }

  async setDate(id: number, date: string): Promise<QuoteView> {
    await this.resolveOrThrow(id);
    const iso = parseQuoteDate(date);
    if (!iso) throw new QuoteError('Use a date like YYYY MM DD.');
    return this.toView(await this.db.quote.update({ where: { id }, data: { quoteDate: iso }, include: WITH_QUOTED_USER }));
  }

  /** A random quote, or null if there are none. */
  async random(): Promise<QuoteView | null> {
    return this.randomWhere({});
  }

  async searchText(term: string): Promise<QuoteView | null> {
    if (!term.trim()) throw new QuoteError('Provide a search term.');
    return this.randomWhere({ text: { contains: term.trim() } });
  }

  /**
   * A random quote by the given person, found under any of their names. Linked
   * quotes match on id — so they're found even if the person has since renamed —
   * while the name is still matched against the stored snapshot to catch quotes
   * that were never linked (guests, imports).
   */
  async searchUser(user: string): Promise<QuoteView | null> {
    const quoted = await this.resolveQuoted(user);
    const byName = { quotedUser: { contains: quoted.name } };
    return this.randomWhere(quoted.id ? { OR: [{ quotedUserId: quoted.id }, byName] } : byName);
  }

  async searchGame(term: string): Promise<QuoteView | null> {
    if (!term.trim()) throw new QuoteError('Provide a game to search for.');
    return this.randomWhere({ game: { contains: term.trim() } });
  }

  async searchDate(date: string): Promise<QuoteView | null> {
    const iso = parseQuoteDate(date);
    if (!iso) throw new QuoteError('Use a date like YYYY MM DD.');
    return this.randomWhere({ quoteDate: iso });
  }

  /** Pick a random quote matching a where-filter. */
  private async randomWhere(where: Record<string, unknown>): Promise<QuoteView | null> {
    const count = await this.db.quote.count({ where });
    if (count === 0) return null;
    const skip = Math.floor(Math.random() * count);
    const [quote] = await this.db.quote.findMany({ where, orderBy: { id: 'asc' }, skip, take: 1, include: WITH_QUOTED_USER });
    return quote ? this.toView(quote) : null;
  }

  /** Every quote, newest ID first, for the dashboard. */
  async listAllForDashboard(): Promise<QuoteView[]> {
    const rows = await this.db.quote.findMany({ orderBy: { id: 'desc' }, include: WITH_QUOTED_USER });
    return rows.map((r) => this.toView(r));
  }

  // ── CSV import ────────────────────────────────────────────────────────────────

  /** Which of the given user ids currently exist (so we never violate the FK). */
  private async existingUserIds(ids: (string | null | undefined)[]): Promise<Set<string>> {
    const want = [...new Set(ids.filter((x): x is string => !!x))];
    if (want.length === 0) return new Set();
    const rows = await this.db.user.findMany({ where: { id: { in: want } }, select: { id: true } });
    return new Set(rows.map((r) => r.id));
  }

  /**
   * Map imported items to valid create rows (skips rows with no text or user).
   * `withId` preserves the quote number (only safe on a full replace, since ids
   * are the primary key); `createdAt` is honored when present.
   */
  private async toCreateRows(items: QuoteImportItem[], withId: boolean) {
    const known = await this.existingUserIds([
      ...items.map((it) => it.quotedById),
      ...items.map((it) => it.userId),
    ]);
    return items
      .map((it) => {
        const createdById = it.quotedById && known.has(it.quotedById) ? it.quotedById : null;
        const quotedUserId = it.userId && known.has(it.userId) ? it.userId : null;
        const idNum = Number(it.id);
        const createdAt = parseTimestamp(it.createdAt);
        return {
          id: withId && Number.isInteger(idNum) && idNum > 0 ? idNum : undefined,
          text: (it.text ?? '').trim().slice(0, 500),
          quotedUser: normalizeUser(it.user ?? ''),
          quotedUserId,
          game: (it.game ?? '').toString().trim() || null,
          quoteDate: parseQuoteDate(it.date ?? '') ?? todayIso(),
          createdByName: (it.quotedByName ?? '').toString().trim() || null,
          createdById,
          createdAt: createdAt ?? undefined,
        };
      })
      .filter((r) => r.text.length > 0 && r.quotedUser.length > 0);
  }

  /** Add imported quotes (additive; new ids). Returns the number created. */
  async bulkImport(items: QuoteImportItem[]): Promise<number> {
    const data = await this.toCreateRows(items, false);
    if (data.length === 0) return 0;
    const { count } = await this.db.quote.createMany({ data });
    return count;
  }

  /** Replace ALL quotes with the imported set (atomic; preserves ids + timestamps for a true restore). */
  async replaceAllWith(items: QuoteImportItem[]): Promise<number> {
    const data = await this.toCreateRows(items, true);
    const [, created] = await this.db.$transaction([
      this.db.quote.deleteMany({}),
      this.db.quote.createMany({ data }),
    ]);
    return created.count;
  }
}
