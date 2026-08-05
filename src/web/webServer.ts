import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { AppConfig } from '../services/config.js';
import { scopedLogger } from '../services/logger.js';
import { HttpError, LEVEL_LABELS, IMPORT_MAX_BYTES, labelToLevel } from './httpShared.js';
import type { UsersService } from '../services/users.js';
import type { CustomCommandService, TargetRef } from '../services/customCommands.js';
import type { ListsService, ListImportItem } from '../services/lists.js';
import type { QuotesService } from '../services/quotes.js';
import type { PointsService } from '../services/points.js';
import type { TimerService } from '../services/timers.js';
import type { FirstService } from '../services/first.js';
import type { TextStringsService } from '../services/textStrings.js';
import type { TtsService } from '../services/tts.js';
import type { EventBus } from '../core/eventBus.js';
import { parseCsv, toCsv, mapCsvRows, type CsvColumn } from '../services/csv.js';
import { PermissionLevel } from '../core/events.js';
import type { CommandRouter } from '../core/commandRouter.js';
import type { ChannelRelationshipService } from './auth/channelRelationship.js';
import { SESSION_COOKIE, verifySession, parseCookies } from './auth/session.js';
import type { SessionData } from './auth/types.js';
import { welcomePage } from './pages/welcome.js';
import { userPage } from './pages/user.js';
import { commandsPage } from './pages/commands.js';
import { listsPage } from './pages/lists.js';
import { quotesPage } from './pages/quotes.js';
import { adminPage } from './pages/admin.js';
import { firstOverlayPage } from './pages/overlayFirst.js';
import { ttsOverlayPage } from './pages/overlayTts.js';

import { handleLogin, handleCallback, handleLogout, getMe, postDisplayName, postAlias } from './routes/authRoutes.js';
import { getCommands, postCommand, createCommand, deleteCommand, addCommandAlias, updateCommandAlias, removeCommandAlias, exportCommands, importCommands } from './routes/commandsRoutes.js';
import { getLists, createList, updateList, deleteList, addListEntry, updateListEntry, deleteListEntry, exportLists, importLists } from './routes/listsRoutes.js';
import { getQuotes, updateQuote, deleteQuote, exportQuotes, importQuotes } from './routes/quotesRoutes.js';
import { getTimers, createTimer, updateTimer, deleteTimer, setTimerLoop } from './routes/timersRoutes.js';
import { getFirstOverlayData, getTtsAudio, getAdminOverlays } from './routes/overlayRoutes.js';
import { getAdminUsers, getAdminStrings, postAdminString, getAdminTts, getAdminTtsPreview, postAdminTts, postAdminTtsSay, initAdminUser, updateAdminUser, deleteAdminUser, simulateEvent } from './routes/adminRoutes.js';

const log = scopedLogger('webServer');
const PUBLIC_DIR = path.resolve('public');
const MAX_BODY_BYTES = 16 * 1024;

const ASSET_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.css': 'text/css',
  '.js': 'text/javascript',
};

/**
 * The bot's web surface: the multi-page dashboard (welcome / profile / commands),
 * the "Login with Twitch" OAuth flow, static assets, and a JSON API. Runs behind
 * Caddy (TLS); cookies are Secure when publicUrl is https.
 *
 * This class owns the HTTP server, the request routing (`handle`), and the shared
 * infrastructure (auth/session, JSON/CSV responses, `readJson`). The actual API
 * handlers live in `./routes/*` as free functions that receive this server for
 * its helpers + services — keeping each domain's endpoints in its own file.
 */
export class WebServer {
  server?: Server;

  constructor(
    readonly config: AppConfig,
    readonly relationships: ChannelRelationshipService,
    readonly users: UsersService,
    readonly customCommands: CustomCommandService,
    readonly commands: CommandRouter,
    readonly lists: ListsService,
    readonly quotes: QuotesService,
    readonly points: PointsService,
    readonly bus: EventBus,
    readonly timers: TimerService,
    readonly first: FirstService,
    readonly text: TextStringsService,
    readonly tts: TtsService,
  ) {}

  start(): void {
    this.server = createServer((req, res) => {
      this.handle(req, res).catch((err) => {
        if (err instanceof HttpError) return this.json(res, err.status, { error: err.message });
        log.error({ err, url: req.url }, 'request handler threw');
        this.send(res, 500, 'text/plain', 'Internal Server Error');
      });
    });
    this.server.listen(this.config.web.httpPort, () =>
      log.info({ port: this.config.web.httpPort, publicUrl: this.config.web.publicUrl }, 'HTTP server listening'),
    );
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
    });
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', this.config.web.publicUrl);
    const p = url.pathname;
    const method = req.method ?? 'GET';

    // Static assets.
    if (method === 'GET' && p.startsWith('/assets/')) return this.serveAsset(res, p);
    // Token-gated TTS audio clips (dynamic id, so before the exact-match switch).
    if (method === 'GET' && p.startsWith('/overlays/tts/audio/')) return getTtsAudio(this, req, res, url);

    if (method === 'GET') {
      switch (p) {
        case '/':
          return this.html(res, welcomePage());
        case '/user':
          return this.requireSession(req, res) ? this.html(res, userPage()) : undefined;
        case '/commands':
          // Public: logged-out visitors browse read-only (viewer access).
          return this.html(res, commandsPage());
        case '/lists':
          // Public: logged-out visitors browse read-only (viewer access).
          return this.html(res, listsPage());
        case '/quotes':
          // Public: logged-out visitors browse read-only (viewer access).
          return this.html(res, quotesPage());
        case '/admin':
          // Broadcaster / bot admins only — the page itself is the gate, and
          // every /api/admin route re-checks rather than trusting the redirect.
          return this.requireAdminPage(req, res) ? this.html(res, adminPage()) : undefined;
        case '/overlays/first':
          // OBS overlay page. Public HTML — it shows nothing without the
          // read-only ?token=... it uses to fetch data + subscribe.
          return this.html(res, firstOverlayPage());
        case '/overlays/tts':
          // OBS audio overlay. Public HTML; inert without the read-only ?token=.
          return this.html(res, ttsOverlayPage());
        case '/auth/login':
          return handleLogin(this, res);
        case '/auth/callback':
          return handleCallback(this, req, res, url);
        case '/auth/logout':
          return handleLogout(this, res);
        case '/api/me':
          return getMe(this, req, res);
        case '/api/commands':
          return getCommands(this, res);
        case '/api/commands/export':
          return exportCommands(this, req, res);
        case '/api/lists':
          return getLists(this, res);
        case '/api/lists/export':
          return exportLists(this, req, res, url);
        case '/api/quotes':
          return getQuotes(this, res);
        case '/api/quotes/export':
          return exportQuotes(this, req, res);
        case '/api/timers':
          return getTimers(this, res);
        case '/api/overlay/first':
          return getFirstOverlayData(this, req, res, url);
        case '/api/admin/overlays':
          return getAdminOverlays(this, req, res);
        case '/api/admin/users':
          return getAdminUsers(this, req, res);
        case '/api/admin/strings':
          return getAdminStrings(this, req, res);
        case '/api/admin/tts':
          return getAdminTts(this, req, res);
        case '/api/admin/tts/preview':
          return getAdminTtsPreview(this, req, res, url);
        case '/healthz':
          return this.send(res, 200, 'text/plain', 'ok');
        default:
          return this.send(res, 404, 'text/plain', 'Not Found');
      }
    }

    if (method === 'POST') {
      switch (p) {
        case '/api/me/display-name':
          return postDisplayName(this, req, res);
        case '/api/me/aliases':
          return postAlias(this, req, res, 'add');
        case '/api/me/aliases/delete':
          return postAlias(this, req, res, 'remove');
        case '/api/commands':
          return postCommand(this, req, res);
        case '/api/commands/create':
          return createCommand(this, req, res);
        case '/api/commands/delete':
          return deleteCommand(this, req, res);
        case '/api/commands/alias':
          return addCommandAlias(this, req, res);
        case '/api/commands/alias/update':
          return updateCommandAlias(this, req, res);
        case '/api/commands/alias/delete':
          return removeCommandAlias(this, req, res);
        case '/api/commands/import':
          return importCommands(this, req, res);
        case '/api/lists/create':
          return createList(this, req, res);
        case '/api/lists/update':
          return updateList(this, req, res);
        case '/api/lists/delete':
          return deleteList(this, req, res);
        case '/api/lists/entries/add':
          return addListEntry(this, req, res);
        case '/api/lists/entries/update':
          return updateListEntry(this, req, res);
        case '/api/lists/entries/delete':
          return deleteListEntry(this, req, res);
        case '/api/lists/import':
          return importLists(this, req, res);
        case '/api/quotes/update':
          return updateQuote(this, req, res);
        case '/api/quotes/delete':
          return deleteQuote(this, req, res);
        case '/api/quotes/import':
          return importQuotes(this, req, res);
        case '/api/timers/create':
          return createTimer(this, req, res);
        case '/api/timers/update':
          return updateTimer(this, req, res);
        case '/api/timers/delete':
          return deleteTimer(this, req, res);
        case '/api/timers/loop':
          return setTimerLoop(this, req, res);
        case '/api/admin/users/init':
          return initAdminUser(this, req, res);
        case '/api/admin/users/update':
          return updateAdminUser(this, req, res);
        case '/api/admin/users/delete':
          return deleteAdminUser(this, req, res);
        case '/api/admin/simulate':
          return simulateEvent(this, req, res);
        case '/api/admin/strings':
          return postAdminString(this, req, res);
        case '/api/admin/tts':
          return postAdminTts(this, req, res);
        case '/api/admin/tts/say':
          return postAdminTtsSay(this, req, res);
        default:
          return this.send(res, 404, 'text/plain', 'Not Found');
      }
    }

    return this.send(res, 405, 'text/plain', 'Method Not Allowed');
  }

  // ── JSON API ─────────────────────────────────────────────────────────────────

  /** Read a `{kind, name}` custom-command target from a request body. */
  targetFromBody(body: Record<string, unknown>): TargetRef {
    const kind = body.kind === 'phrase' ? 'phrase' : 'trigger';
    const name = String(body.name ?? '').trim();
    if (!name) throw new HttpError(400, 'Missing command name.');
    return { kind, name };
  }

  // ── Overlays API ──────────────────────────────────────────────────────────────

  /** Require the read-only overlay token (query `?token=` or `X-Overlay-Token`). */
  requireOverlayToken(req: IncomingMessage, url: URL): void {
    const configured = this.config.overlayToken;
    if (!configured) throw new HttpError(503, 'Overlays are not configured (set OVERLAY_TOKEN).');
    const provided = url.searchParams.get('token') ?? req.headers['x-overlay-token'];
    if (provided !== configured) throw new HttpError(401, 'Invalid overlay token.');
  }

  // ── Lists API ─────────────────────────────────────────────────────────────────

  /** Map a session's channel relationship to a numeric PermissionLevel. */
  sessionLevel(session: SessionData): number {
    const r = session.relationship;
    if (r.botAdmin) return PermissionLevel.Admin;
    if (r.broadcaster) return PermissionLevel.Broadcaster;
    if (r.moderator) return PermissionLevel.Moderator;
    if (r.subscriber) return PermissionLevel.Subscriber;
    return PermissionLevel.Viewer;
  }

  /**
   * Require mod+ to manage a list, and — if the list is restricted above
   * Moderator (Broadcaster/Admin) — require that level too. Throws on an unknown
   * list (ListError, converted to 400 by the caller).
   */
  async requireListManage(req: IncomingMessage, listName: string): Promise<SessionData> {
    const session = this.requireManager(req);
    const level = await this.lists.addPermission(listName);
    if (level > PermissionLevel.Moderator && this.sessionLevel(session) < level) {
      throw new HttpError(403, `This list is restricted to ${LEVEL_LABELS[level]}+.`);
    }
    return session;
  }

  // ── CSV import / export (mod+) ──────────────────────────────────────────────────

  /** Group per-entry list rows back into structured lists (metadata from the first row of each). */
  groupLists(mapped: Record<string, string>[]): ListImportItem[] {
    const map = new Map<string, ListImportItem>();
    for (const m of mapped) {
      const name = (m.list ?? '').trim();
      if (!name) continue;
      const key = name.toLowerCase();
      let g = map.get(key);
      if (!g) {
        g = {
          name,
          displayName: m.displayName || null,
          description: m.description || null,
          permission: labelToLevel(m.permission ?? ''),
          createdByName: m.createdByName || null,
          createdById: m.createdById || null,
          createdAt: m.createdAt || undefined,
          updatedAt: m.updatedAt || undefined,
          entries: [],
        };
        map.set(key, g);
      }
      if ((m.text ?? '').trim()) g.entries!.push({ text: m.text!, addedByName: m.addedByName, addedById: m.addedById, addedAt: m.addedAt });
    }
    return [...map.values()];
  }

  /** Replacing all lists needs mod+ AND at least the highest restriction level among existing lists. */
  async requireBulkListManager(req: IncomingMessage): Promise<SessionData> {
    const session = this.requireManager(req);
    const max = await this.lists.maxPermission();
    if (this.sessionLevel(session) < max) {
      throw new HttpError(403, `Replacing all lists requires ${LEVEL_LABELS[max]}+ (a list is restricted to that level).`);
    }
    return session;
  }

  // ── Session / CSRF helpers ────────────────────────────────────────────────────

  getSession(req: IncomingMessage): SessionData | null {
    return verifySession(parseCookies(req.headers.cookie)[SESSION_COOKIE], this.config.web.sessionSecret);
  }

  /** For page routes: if unauthenticated, redirect to `/` and return false. */
  requireSession(req: IncomingMessage, res: ServerResponse): boolean {
    if (this.getSession(req)) return true;
    this.redirect(res, '/');
    return false;
  }

  /**
   * Require the caller to be the broadcaster or a bot admin. Stricter than
   * `requireManager` — moderators can manage content, but not other people's
   * accounts, points, or event injection.
   */
  requireAdmin(req: IncomingMessage): SessionData {
    const session = this.requireApiSession(req);
    const r = session.relationship;
    if (!(r.broadcaster || r.botAdmin)) throw new HttpError(403, 'Broadcaster or bot admin access required.');
    return session;
  }

  /** Page-level admin gate: redirect rather than error, like `requireSession`. */
  requireAdminPage(req: IncomingMessage, res: ServerResponse): boolean {
    const session = this.getSession(req);
    if (session && (session.relationship.broadcaster || session.relationship.botAdmin)) return true;
    this.redirect(res, '/');
    return false;
  }

  /** For API routes: require a session + a same-origin request, or throw. */
  requireApiSession(req: IncomingMessage): SessionData {
    this.assertSameOrigin(req);
    const session = this.getSession(req);
    if (!session) throw new HttpError(401, 'unauthenticated');
    return session;
  }

  /** Require the caller to be a moderator or above (mod / broadcaster / admin). */
  requireManager(req: IncomingMessage): SessionData {
    const session = this.requireApiSession(req);
    const r = session.relationship;
    if (!(r.moderator || r.broadcaster || r.botAdmin)) throw new HttpError(403, 'Moderator access required.');
    return session;
  }

  /** CSRF defense: reject state-changing requests whose Origin isn't ours. */
  assertSameOrigin(req: IncomingMessage): void {
    const origin = req.headers.origin;
    if (origin && origin !== this.config.web.publicUrl) throw new HttpError(403, 'Bad origin.');
  }

  async readJson(req: IncomingMessage, maxBytes = MAX_BODY_BYTES): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > maxBytes) throw new HttpError(413, 'Body too large.');
      chunks.push(chunk as Buffer);
    }
    if (chunks.length === 0) return {};
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
    } catch {
      throw new HttpError(400, 'Invalid JSON.');
    }
  }

  // ── Response helpers ──────────────────────────────────────────────────────────

  async serveAsset(res: ServerResponse, pathname: string): Promise<void> {
    const name = pathname.slice('/assets/'.length);
    if (!/^[a-zA-Z0-9._-]+$/.test(name)) return this.send(res, 404, 'text/plain', 'Not Found');
    const ext = path.extname(name).toLowerCase();
    const type = ASSET_TYPES[ext];
    if (!type) return this.send(res, 404, 'text/plain', 'Not Found');
    try {
      const data = await readFile(path.join(PUBLIC_DIR, 'assets', name));
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'public, max-age=3600' });
      res.end(data);
    } catch {
      this.send(res, 404, 'text/plain', 'Not Found');
    }
  }

  html(res: ServerResponse, body: string): void {
    this.securityHeaders(res);
    this.send(res, 200, 'text/html; charset=utf-8', body);
  }

  json(res: ServerResponse, status: number, obj: unknown): void {
    this.send(res, status, 'application/json', JSON.stringify(obj));
  }

  csvDownload(res: ServerResponse, filename: string, csv: string): void {
    this.securityHeaders(res);
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename.replace(/[^a-zA-Z0-9._-]/g, '_')}"`,
    });
    res.end(csv);
  }

  /** Serialize a header + data rows to CSV and send it as a download. */
  csvExport(res: ServerResponse, filename: string, header: string[], rows: (string | number)[][]): void {
    this.csvDownload(res, filename, toCsv([header, ...rows]));
  }

  /** Read an import request body (larger cap) and map its CSV into keyed rows. */
  async parseCsvImport(
    req: IncomingMessage,
    spec: CsvColumn[],
  ): Promise<{ body: Record<string, unknown>; rows: Record<string, string>[] }> {
    const body = await this.readJson(req, IMPORT_MAX_BYTES);
    return { body, rows: mapCsvRows(parseCsv(String(body.csv ?? '')), spec) };
  }

  send(res: ServerResponse, status: number, contentType: string, body: string): void {
    res.writeHead(status, { 'Content-Type': contentType });
    res.end(body);
  }

  redirect(res: ServerResponse, location: string): void {
    res.writeHead(302, { Location: location });
    res.end();
  }

  securityHeaders(res: ServerResponse): void {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; img-src 'self' https://*.jtvnw.net data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'",
    );
  }
}
