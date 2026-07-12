import type { Storage } from './storage/index.js';

/** User-facing error (message is safe to show in chat / API responses). */
export class QuoteError extends Error {}

/** Who added a quote — id (for the FK) plus a snapshot of the display name. */
export interface Actor {
  id: string;
  displayName: string;
}

/** A quote as surfaced to the dashboard / chat formatting. */
export interface QuoteView {
  id: number;
  text: string;
  user: string;
  game: string | null;
  date: string; // "YYYY-MM-DD"
  quotedByName: string | null;
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

/** Format a quote for chat: `Quote 5: "text" - @user [Game] [2024/01/02]`. */
export function formatQuote(q: QuoteView): string {
  const game = q.game && q.game.trim() ? ` [${q.game.trim()}]` : '';
  const date = q.date ? ` [${q.date.replace(/-/g, '/')}]` : '';
  return `Quote ${q.id}: "${q.text}" - @${q.user}${game}${date}`;
}

/**
 * Owns quotes: CRUD used by the chat `!quote` manager and the dashboard, plus
 * the random/search lookups. `id` is the public quote number. Callers that pass
 * an `Actor` must ensure that user exists (UsersService.touch) first — quotes
 * reference User by foreign key.
 */
export class QuotesService {
  constructor(private readonly storage: Storage) {}

  private get db() {
    return this.storage.prisma;
  }

  private toView = (q: {
    id: number; text: string; quotedUser: string; game: string | null; quoteDate: string; createdByName: string | null; createdAt: Date;
  }): QuoteView => ({
    id: q.id,
    text: q.text,
    user: q.quotedUser,
    game: q.game,
    date: q.quoteDate,
    quotedByName: q.createdByName,
    createdAt: q.createdAt.toISOString(),
  });

  private async resolveOrThrow(channel: string, id: number) {
    if (!Number.isInteger(id) || id <= 0) throw new QuoteError('Provide a numeric quote ID.');
    const quote = await this.db.quote.findFirst({ where: { id, channel } });
    if (!quote) throw new QuoteError(`No quote found with ID ${id}.`);
    return quote;
  }

  async add(
    channel: string,
    data: { user: string; text: string; game?: string | null; date?: string },
    creator?: Actor,
  ): Promise<QuoteView> {
    const user = normalizeUser(data.user);
    if (!user) throw new QuoteError('Provide the @username being quoted.');
    const text = data.text.trim();
    if (!text) throw new QuoteError('Provide the quote text.');
    if (text.length > 500) throw new QuoteError('Quote is too long (max 500).');
    const date = data.date ?? todayIso();
    const quote = await this.db.quote.create({
      data: {
        channel,
        text,
        quotedUser: user,
        game: (data.game ?? '').trim() || null,
        quoteDate: date,
        createdById: creator?.id ?? null,
        createdByName: creator?.displayName ?? null,
      },
    });
    return this.toView(quote);
  }

  async getById(channel: string, id: number): Promise<QuoteView> {
    return this.toView(await this.resolveOrThrow(channel, id));
  }

  async remove(channel: string, id: number): Promise<void> {
    await this.resolveOrThrow(channel, id);
    await this.db.quote.delete({ where: { id } });
  }

  async setText(channel: string, id: number, text: string): Promise<QuoteView> {
    await this.resolveOrThrow(channel, id);
    const value = text.trim();
    if (!value) throw new QuoteError('Quote text cannot be empty.');
    if (value.length > 500) throw new QuoteError('Quote is too long (max 500).');
    return this.toView(await this.db.quote.update({ where: { id }, data: { text: value } }));
  }

  async setUser(channel: string, id: number, user: string): Promise<QuoteView> {
    await this.resolveOrThrow(channel, id);
    const value = normalizeUser(user);
    if (!value) throw new QuoteError('Provide a username.');
    return this.toView(await this.db.quote.update({ where: { id }, data: { quotedUser: value } }));
  }

  async setGame(channel: string, id: number, game: string): Promise<QuoteView> {
    await this.resolveOrThrow(channel, id);
    return this.toView(await this.db.quote.update({ where: { id }, data: { game: game.trim() || null } }));
  }

  async setDate(channel: string, id: number, date: string): Promise<QuoteView> {
    await this.resolveOrThrow(channel, id);
    const iso = parseQuoteDate(date);
    if (!iso) throw new QuoteError('Use a date like YYYY MM DD.');
    return this.toView(await this.db.quote.update({ where: { id }, data: { quoteDate: iso } }));
  }

  /** A random quote from the channel, or null if there are none. */
  async random(channel: string): Promise<QuoteView | null> {
    return this.randomWhere(channel, {});
  }

  async searchText(channel: string, term: string): Promise<QuoteView | null> {
    if (!term.trim()) throw new QuoteError('Provide a search term.');
    return this.randomWhere(channel, { text: { contains: term.trim() } });
  }

  async searchUser(channel: string, user: string): Promise<QuoteView | null> {
    const value = normalizeUser(user);
    if (!value) throw new QuoteError('Provide a username.');
    return this.randomWhere(channel, { quotedUser: { contains: value } });
  }

  async searchGame(channel: string, term: string): Promise<QuoteView | null> {
    if (!term.trim()) throw new QuoteError('Provide a game to search for.');
    return this.randomWhere(channel, { game: { contains: term.trim() } });
  }

  async searchDate(channel: string, date: string): Promise<QuoteView | null> {
    const iso = parseQuoteDate(date);
    if (!iso) throw new QuoteError('Use a date like YYYY MM DD.');
    return this.randomWhere(channel, { quoteDate: iso });
  }

  /** Pick a random quote matching a where-filter (channel is always applied). */
  private async randomWhere(channel: string, where: Record<string, unknown>): Promise<QuoteView | null> {
    const full = { channel, ...where };
    const count = await this.db.quote.count({ where: full });
    if (count === 0) return null;
    const skip = Math.floor(Math.random() * count);
    const [quote] = await this.db.quote.findMany({ where: full, orderBy: { id: 'asc' }, skip, take: 1 });
    return quote ? this.toView(quote) : null;
  }

  /** Every quote in a channel, newest ID first, for the dashboard. */
  async listAllForDashboard(channel: string): Promise<QuoteView[]> {
    const rows = await this.db.quote.findMany({ where: { channel }, orderBy: { id: 'desc' } });
    return rows.map((r) => this.toView(r));
  }
}
