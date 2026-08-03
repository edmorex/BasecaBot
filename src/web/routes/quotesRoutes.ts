/** Quote API routes: read, edit, delete, and CSV import/export (mod+).
 * Free functions taking the WebServer; wired in webServer.ts. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { WebServer } from '../webServer.js';
import { HttpError } from '../httpShared.js';
import { QuoteError } from '../../services/quotes.js';
import { QUOTE_CSV_SPEC } from '../../services/csv.js';

export async function getQuotes(s: WebServer, res: ServerResponse): Promise<void> {
  const quotes = await s.quotes.listAllForDashboard();
  s.json(res, 200, { quotes });
}

export async function updateQuote(s: WebServer, req: IncomingMessage, res: ServerResponse): Promise<void> {
  s.requireManager(req);
  const body = await s.readJson(req);
  const id = Number(body.id);
  try {
    if ('text' in body) await s.quotes.setText(id, String(body.text ?? ''));
    if ('user' in body) await s.quotes.setUser(id, String(body.user ?? ''));
    if ('game' in body) await s.quotes.setGame(id, String(body.game ?? ''));
    if ('date' in body) await s.quotes.setDate(id, String(body.date ?? ''));
  } catch (e) {
    if (e instanceof QuoteError) throw new HttpError(400, e.message);
    throw e;
  }
  s.json(res, 200, { ok: true });
}

export async function deleteQuote(s: WebServer, req: IncomingMessage, res: ServerResponse): Promise<void> {
  s.requireManager(req);
  const body = await s.readJson(req);
  try {
    await s.quotes.remove(Number(body.id));
  } catch (e) {
    if (e instanceof QuoteError) throw new HttpError(400, e.message);
    throw e;
  }
  s.json(res, 200, { ok: true });
}

export async function exportQuotes(s: WebServer, req: IncomingMessage, res: ServerResponse): Promise<void> {
  s.requireManager(req);
  const quotes = await s.quotes.listAllForDashboard();
  const rows: (string | number)[][] = [];
  for (const q of quotes) rows.push([q.id, q.text, q.user, q.userId ?? '', q.game ?? '', q.date, q.quotedByName ?? '', q.quotedById ?? '', q.createdAt]);
  s.csvExport(res, 'quotes.csv', ['ID', 'Quote', 'User', 'User ID', 'Game', 'Date', 'Quoted By', 'Quoted By ID', 'Created At'], rows);
}

export async function importQuotes(s: WebServer, req: IncomingMessage, res: ServerResponse): Promise<void> {
  s.requireManager(req);
  const { body, rows } = await s.parseCsvImport(req, QUOTE_CSV_SPEC);
  const mode = body.mode === 'replace' ? 'replace' : 'add';
  const items = rows.map((m) => ({
    id: m.id,
    text: m.text!,
    user: m.user!,
    userId: m.userId,
    game: m.game,
    date: m.date,
    quotedByName: m.quotedByName,
    quotedById: m.quotedById,
    createdAt: m.createdAt,
  }));
  const added = mode === 'replace' ? await s.quotes.replaceAllWith(items) : await s.quotes.bulkImport(items);
  s.json(res, 200, { ok: true, mode, added });
}
