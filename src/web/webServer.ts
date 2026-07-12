import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { AppConfig } from '../services/config.js';
import { scopedLogger } from '../services/logger.js';
import type { UsersService } from '../services/users.js';
import { AliasError } from '../services/users.js';
import type { CustomCommandService, TargetRef } from '../services/customCommands.js';
import { CommandError } from '../services/customCommands.js';
import type { ListsService } from '../services/lists.js';
import { ListError } from '../services/lists.js';
import type { QuotesService } from '../services/quotes.js';
import { QuoteError } from '../services/quotes.js';
import { PermissionLevel } from '../core/events.js';
import type { CommandRouter } from '../core/commandRouter.js';
import type { ChannelRelationshipService } from './auth/channelRelationship.js';
import { buildAuthorizeUrl, exchangeCodeForToken, fetchAuthedUser } from './auth/twitchOAuth.js';
import {
  SESSION_COOKIE,
  OAUTH_STATE_COOKIE,
  signSession,
  verifySession,
  randomState,
  parseCookies,
  serializeCookie,
} from './auth/session.js';
import type { SessionData } from './auth/types.js';
import { welcomePage } from './pages/welcome.js';
import { userPage } from './pages/user.js';
import { commandsPage } from './pages/commands.js';
import { listsPage } from './pages/lists.js';
import { quotesPage } from './pages/quotes.js';

const log = scopedLogger('webServer');
const PUBLIC_DIR = path.resolve('public');
const MAX_BODY_BYTES = 16 * 1024;
const LEVEL_LABELS = ['Everyone', 'Subscriber', 'VIP', 'Moderator', 'Broadcaster', 'Admin'];

const ASSET_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.css': 'text/css',
  '.js': 'text/javascript',
};

/** Thrown by handlers to return a specific HTTP status with a JSON error. */
class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * The bot's web surface: the multi-page dashboard (welcome / profile /
 * commands), the "Login with Twitch" OAuth flow, static assets, and a JSON API.
 * Runs behind Caddy (TLS); cookies are Secure when publicUrl is https.
 */
export class WebServer {
  private server?: Server;
  private readonly channel: string;

  constructor(
    private readonly config: AppConfig,
    private readonly relationships: ChannelRelationshipService,
    private readonly users: UsersService,
    private readonly customCommands: CustomCommandService,
    private readonly commands: CommandRouter,
    private readonly lists: ListsService,
    private readonly quotes: QuotesService,
  ) {
    this.channel = config.twitch.channels[0] ?? 'unknown';
  }

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

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', this.config.web.publicUrl);
    const p = url.pathname;
    const method = req.method ?? 'GET';

    // Static assets.
    if (method === 'GET' && p.startsWith('/assets/')) return this.serveAsset(res, p);

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
        case '/auth/login':
          return this.handleLogin(res);
        case '/auth/callback':
          return this.handleCallback(req, res, url);
        case '/auth/logout':
          return this.handleLogout(res);
        case '/api/me':
          return this.getMe(req, res);
        case '/api/commands':
          return this.getCommands(res);
        case '/api/lists':
          return this.getLists(res);
        case '/api/quotes':
          return this.getQuotes(res);
        case '/healthz':
          return this.send(res, 200, 'text/plain', 'ok');
        default:
          return this.send(res, 404, 'text/plain', 'Not Found');
      }
    }

    if (method === 'POST') {
      switch (p) {
        case '/api/me/display-name':
          return this.postDisplayName(req, res);
        case '/api/me/aliases':
          return this.postAlias(req, res, 'add');
        case '/api/me/aliases/delete':
          return this.postAlias(req, res, 'remove');
        case '/api/commands':
          return this.postCommand(req, res);
        case '/api/commands/create':
          return this.createCommand(req, res);
        case '/api/commands/delete':
          return this.deleteCommand(req, res);
        case '/api/commands/alias':
          return this.addCommandAlias(req, res);
        case '/api/commands/alias/delete':
          return this.removeCommandAlias(req, res);
        case '/api/lists/create':
          return this.createList(req, res);
        case '/api/lists/update':
          return this.updateList(req, res);
        case '/api/lists/delete':
          return this.deleteList(req, res);
        case '/api/lists/entries/add':
          return this.addListEntry(req, res);
        case '/api/lists/entries/update':
          return this.updateListEntry(req, res);
        case '/api/lists/entries/delete':
          return this.deleteListEntry(req, res);
        case '/api/quotes/update':
          return this.updateQuote(req, res);
        case '/api/quotes/delete':
          return this.deleteQuote(req, res);
        default:
          return this.send(res, 404, 'text/plain', 'Not Found');
      }
    }

    return this.send(res, 405, 'text/plain', 'Method Not Allowed');
  }

  // ── Auth flow ───────────────────────────────────────────────────────────────

  private handleLogin(res: ServerResponse): void {
    const state = randomState();
    res.setHeader('Set-Cookie', serializeCookie(OAUTH_STATE_COOKIE, state, {
      maxAgeSeconds: 600, httpOnly: true, secure: this.config.web.secureCookies, sameSite: 'Lax',
    }));
    this.redirect(res, buildAuthorizeUrl(this.config, state));
  }

  private async handleCallback(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    if (url.searchParams.get('error')) return this.redirect(res, '/');
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const expectedState = parseCookies(req.headers.cookie)[OAUTH_STATE_COOKIE];
    if (!code || !state || !expectedState || state !== expectedState) {
      log.warn('OAuth callback with missing/mismatched state');
      return this.send(res, 400, 'text/plain', 'Invalid OAuth state. Please try logging in again.');
    }

    const token = await exchangeCodeForToken(this.config, code);
    const user = await fetchAuthedUser(this.config, token);
    // Remember the user in the DB (creates the profile; keeps a custom display
    // name intact via displayNameLocked).
    await this.users.touch({ id: user.id, login: user.login, displayName: user.displayName, avatarUrl: user.avatar });
    const relationship = await this.relationships.compute(user);

    const session = signSession({ user, relationship }, this.config.web.sessionSecret);
    res.setHeader('Set-Cookie', [
      serializeCookie(SESSION_COOKIE, session, {
        maxAgeSeconds: 8 * 60 * 60, httpOnly: true, secure: this.config.web.secureCookies, sameSite: 'Lax',
      }),
      serializeCookie(OAUTH_STATE_COOKIE, '', { maxAgeSeconds: 0, secure: this.config.web.secureCookies }),
    ]);
    log.info({ login: user.login }, 'user logged in');
    this.redirect(res, '/user');
  }

  private handleLogout(res: ServerResponse): void {
    res.setHeader('Set-Cookie', serializeCookie(SESSION_COOKIE, '', { maxAgeSeconds: 0, secure: this.config.web.secureCookies }));
    this.redirect(res, '/');
  }

  // ── JSON API ─────────────────────────────────────────────────────────────────

  private async getMe(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const session = this.getSession(req);
    if (!session) throw new HttpError(401, 'unauthenticated');
    const profile = await this.users.getProfile(session.user.id);
    this.json(res, 200, {
      user: {
        twitchId: session.user.id,
        login: session.user.login,
        canonical: profile?.canonical ?? `@${session.user.login}`,
        displayName: profile?.displayName ?? session.user.displayName,
        avatar: session.user.avatar,
      },
      relationship: session.relationship,
      aliases: profile?.aliases ?? [],
    });
  }

  private async postDisplayName(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const session = this.requireApiSession(req);
    const body = await this.readJson(req);
    try {
      await this.users.setDisplayName(session.user.id, String(body.displayName ?? ''));
    } catch (e) {
      if (e instanceof AliasError) throw new HttpError(400, e.message);
      throw e;
    }
    const profile = await this.users.getProfile(session.user.id);
    this.json(res, 200, { displayName: profile?.displayName });
  }

  private async postAlias(req: IncomingMessage, res: ServerResponse, op: 'add' | 'remove'): Promise<void> {
    const session = this.requireApiSession(req);
    const body = await this.readJson(req);
    const alias = String(body.alias ?? '');
    try {
      if (op === 'add') await this.users.addAlias(session.user.id, alias);
      else await this.users.removeAlias(session.user.id, alias);
    } catch (e) {
      if (e instanceof AliasError) throw new HttpError(400, e.message);
      throw e;
    }
    const profile = await this.users.getProfile(session.user.id);
    this.json(res, 200, { aliases: profile?.aliases ?? [] });
  }

  private async getCommands(res: ServerResponse): Promise<void> {
    const builtins = this.commands.list().map((c) => ({
      kind: 'builtin' as const, name: c.name, usage: c.usage ?? '', group: c.group ?? 'other', access: c.permission, description: c.description,
      response: null as string | null, globalCooldown: c.globalCooldown, userCooldown: c.userCooldown,
      enabled: true, usageCount: 0, aliases: [] as string[],
    }));
    const customs = (await this.customCommands.listForDashboard(this.channel)).map((c) => ({
      kind: c.kind, name: c.name, access: c.permission, group: c.group,
      response: c.response, globalCooldown: c.globalCooldown, userCooldown: c.userCooldown,
      enabled: c.enabled, usageCount: c.usageCount, aliases: c.aliases,
    }));
    const commands = [...builtins, ...customs].sort((a, b) => a.name.localeCompare(b.name));
    this.json(res, 200, { commands });
  }

  /** Read a `{kind, name}` custom-command target from a request body. */
  private targetFromBody(body: Record<string, unknown>): TargetRef {
    const kind = body.kind === 'phrase' ? 'phrase' : 'trigger';
    const name = String(body.name ?? '').trim();
    if (!name) throw new HttpError(400, 'Missing command name.');
    return { kind, name };
  }

  /** Update an existing custom command's editable fields (dashboard edit). */
  private async postCommand(req: IncomingMessage, res: ServerResponse): Promise<void> {
    this.requireManager(req);
    const body = await this.readJson(req);
    const target = this.targetFromBody(body);
    try {
      if ('response' in body) await this.customCommands.setResponse(this.channel, target, body.response == null ? null : String(body.response));
      if ('group' in body) await this.customCommands.setGroup(this.channel, target, String(body.group ?? ''));
      if ('permission' in body) await this.customCommands.setPermission(this.channel, target, Number(body.permission) || 0);
      if ('globalCooldown' in body || 'userCooldown' in body) {
        await this.customCommands.setCooldown(this.channel, target, Number(body.globalCooldown) || 0, Number(body.userCooldown) || 0);
      }
      if ('enabled' in body) await this.customCommands.setEnabled(this.channel, target, Boolean(body.enabled));
      if ('usageCount' in body) await this.customCommands.setUsageCount(this.channel, target, Number(body.usageCount) || 0);
    } catch (e) {
      if (e instanceof CommandError) throw new HttpError(400, e.message);
      throw e;
    }
    this.json(res, 200, { ok: true });
  }

  /** Create a new custom command (dashboard "New Command"). */
  private async createCommand(req: IncomingMessage, res: ServerResponse): Promise<void> {
    this.requireManager(req);
    const body = await this.readJson(req);
    const target = this.targetFromBody(body);
    try {
      await this.customCommands.create(this.channel, target, {
        response: body.response == null ? null : String(body.response),
        permission: Number(body.permission) || 0,
        globalCooldown: Number(body.globalCooldown) || 0,
        userCooldown: Number(body.userCooldown) || 0,
      });
      if (body.group != null && String(body.group).trim()) await this.customCommands.setGroup(this.channel, target, String(body.group));
      if (body.enabled === false) await this.customCommands.setEnabled(this.channel, target, false);
    } catch (e) {
      if (e instanceof CommandError) throw new HttpError(400, e.message);
      throw e;
    }
    this.json(res, 200, { ok: true });
  }

  private async deleteCommand(req: IncomingMessage, res: ServerResponse): Promise<void> {
    this.requireManager(req);
    const target = this.targetFromBody(await this.readJson(req));
    try {
      await this.customCommands.remove(this.channel, target);
    } catch (e) {
      if (e instanceof CommandError) throw new HttpError(404, e.message);
      throw e;
    }
    this.json(res, 200, { ok: true });
  }

  private async addCommandAlias(req: IncomingMessage, res: ServerResponse): Promise<void> {
    this.requireManager(req);
    const body = await this.readJson(req);
    const target = this.targetFromBody(body);
    try {
      await this.customCommands.addAlias(this.channel, target, String(body.alias ?? ''));
    } catch (e) {
      if (e instanceof CommandError) throw new HttpError(400, e.message);
      throw e;
    }
    this.json(res, 200, { ok: true });
  }

  private async removeCommandAlias(req: IncomingMessage, res: ServerResponse): Promise<void> {
    this.requireManager(req);
    const body = await this.readJson(req);
    try {
      await this.customCommands.removeAlias(this.channel, String(body.alias ?? ''));
    } catch (e) {
      if (e instanceof CommandError) throw new HttpError(400, e.message);
      throw e;
    }
    this.json(res, 200, { ok: true });
  }

  // ── Lists API ─────────────────────────────────────────────────────────────────

  /** Every list with its entries (public read — logged-out sees viewer access). */
  private async getLists(res: ServerResponse): Promise<void> {
    const lists = await this.lists.listAllForDashboard(this.channel);
    this.json(res, 200, { lists });
  }

  /** Map a session's channel relationship to a numeric PermissionLevel. */
  private sessionLevel(session: SessionData): number {
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
  private async requireListManage(req: IncomingMessage, listName: string): Promise<SessionData> {
    const session = this.requireManager(req);
    const level = await this.lists.addPermission(this.channel, listName);
    if (level > PermissionLevel.Moderator && this.sessionLevel(session) < level) {
      throw new HttpError(403, `This list is restricted to ${LEVEL_LABELS[level]}+.`);
    }
    return session;
  }

  private async createList(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const session = this.requireManager(req);
    const body = await this.readJson(req);
    const name = String(body.name ?? '').trim();
    const actor = { id: session.user.id, displayName: session.user.displayName };
    try {
      await this.lists.create(this.channel, name, body.displayName == null ? undefined : String(body.displayName), actor);
      if (body.description != null && String(body.description).trim()) await this.lists.setDescription(this.channel, name, String(body.description));
      if (body.permission != null) await this.lists.setPermission(this.channel, name, Number(body.permission) || PermissionLevel.Moderator);
    } catch (e) {
      if (e instanceof ListError) throw new HttpError(400, e.message);
      throw e;
    }
    this.json(res, 200, { ok: true });
  }

  private async updateList(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.readJson(req);
    const name = String(body.name ?? '').trim();
    try {
      await this.requireListManage(req, name);
      if ('displayName' in body) await this.lists.setDisplayName(this.channel, name, String(body.displayName ?? ''));
      if ('description' in body) await this.lists.setDescription(this.channel, name, String(body.description ?? ''));
      if ('permission' in body) await this.lists.setPermission(this.channel, name, Number(body.permission) || 0);
      if (body.newName != null && String(body.newName).trim()) await this.lists.rename(this.channel, name, String(body.newName));
    } catch (e) {
      if (e instanceof ListError) throw new HttpError(400, e.message);
      throw e;
    }
    this.json(res, 200, { ok: true });
  }

  private async deleteList(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.readJson(req);
    const name = String(body.name ?? '').trim();
    try {
      await this.requireListManage(req, name);
      await this.lists.remove(this.channel, name);
    } catch (e) {
      if (e instanceof ListError) throw new HttpError(400, e.message);
      throw e;
    }
    this.json(res, 200, { ok: true });
  }

  private async addListEntry(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const session = this.requireApiSession(req);
    const body = await this.readJson(req);
    const name = String(body.list ?? '').trim();
    try {
      const level = await this.lists.addPermission(this.channel, name);
      if (this.sessionLevel(session) < level) throw new HttpError(403, `Only ${LEVEL_LABELS[level]}+ can add to this list.`);
      await this.lists.addEntry(this.channel, name, String(body.text ?? ''), { id: session.user.id, displayName: session.user.displayName });
    } catch (e) {
      if (e instanceof ListError) throw new HttpError(400, e.message);
      throw e;
    }
    this.json(res, 200, { ok: true });
  }

  private async updateListEntry(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.readJson(req);
    const name = String(body.list ?? '').trim();
    try {
      await this.requireListManage(req, name);
      await this.lists.updateEntry(this.channel, name, Number(body.id), String(body.text ?? ''));
    } catch (e) {
      if (e instanceof ListError) throw new HttpError(400, e.message);
      throw e;
    }
    this.json(res, 200, { ok: true });
  }

  private async deleteListEntry(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.readJson(req);
    const name = String(body.list ?? '').trim();
    try {
      await this.requireListManage(req, name);
      await this.lists.removeEntry(this.channel, name, Number(body.id));
    } catch (e) {
      if (e instanceof ListError) throw new HttpError(400, e.message);
      throw e;
    }
    this.json(res, 200, { ok: true });
  }

  // ── Quotes API ────────────────────────────────────────────────────────────────

  /** Every quote (public read — logged-out sees viewer access). */
  private async getQuotes(res: ServerResponse): Promise<void> {
    const quotes = await this.quotes.listAllForDashboard(this.channel);
    this.json(res, 200, { quotes });
  }

  /** Update a quote's editable fields (mod+). */
  private async updateQuote(req: IncomingMessage, res: ServerResponse): Promise<void> {
    this.requireManager(req);
    const body = await this.readJson(req);
    const id = Number(body.id);
    try {
      if ('text' in body) await this.quotes.setText(this.channel, id, String(body.text ?? ''));
      if ('user' in body) await this.quotes.setUser(this.channel, id, String(body.user ?? ''));
      if ('game' in body) await this.quotes.setGame(this.channel, id, String(body.game ?? ''));
      if ('date' in body) await this.quotes.setDate(this.channel, id, String(body.date ?? ''));
    } catch (e) {
      if (e instanceof QuoteError) throw new HttpError(400, e.message);
      throw e;
    }
    this.json(res, 200, { ok: true });
  }

  private async deleteQuote(req: IncomingMessage, res: ServerResponse): Promise<void> {
    this.requireManager(req);
    const body = await this.readJson(req);
    try {
      await this.quotes.remove(this.channel, Number(body.id));
    } catch (e) {
      if (e instanceof QuoteError) throw new HttpError(400, e.message);
      throw e;
    }
    this.json(res, 200, { ok: true });
  }

  // ── Session / CSRF helpers ────────────────────────────────────────────────────

  private getSession(req: IncomingMessage): SessionData | null {
    return verifySession(parseCookies(req.headers.cookie)[SESSION_COOKIE], this.config.web.sessionSecret);
  }

  /** For page routes: if unauthenticated, redirect to `/` and return false. */
  private requireSession(req: IncomingMessage, res: ServerResponse): boolean {
    if (this.getSession(req)) return true;
    this.redirect(res, '/');
    return false;
  }

  /** For API routes: require a session + a same-origin request, or throw. */
  private requireApiSession(req: IncomingMessage): SessionData {
    this.assertSameOrigin(req);
    const session = this.getSession(req);
    if (!session) throw new HttpError(401, 'unauthenticated');
    return session;
  }

  /** Require the caller to be a moderator or above (mod / broadcaster / admin). */
  private requireManager(req: IncomingMessage): SessionData {
    const session = this.requireApiSession(req);
    const r = session.relationship;
    if (!(r.moderator || r.broadcaster || r.botAdmin)) throw new HttpError(403, 'Moderator access required.');
    return session;
  }

  /** CSRF defense: reject state-changing requests whose Origin isn't ours. */
  private assertSameOrigin(req: IncomingMessage): void {
    const origin = req.headers.origin;
    if (origin && origin !== this.config.web.publicUrl) throw new HttpError(403, 'Bad origin.');
  }

  private async readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) throw new HttpError(413, 'Body too large.');
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

  private async serveAsset(res: ServerResponse, pathname: string): Promise<void> {
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

  private html(res: ServerResponse, body: string): void {
    this.securityHeaders(res);
    this.send(res, 200, 'text/html; charset=utf-8', body);
  }

  private json(res: ServerResponse, status: number, obj: unknown): void {
    this.send(res, status, 'application/json', JSON.stringify(obj));
  }

  private send(res: ServerResponse, status: number, contentType: string, body: string): void {
    res.writeHead(status, { 'Content-Type': contentType });
    res.end(body);
  }

  private redirect(res: ServerResponse, location: string): void {
    res.writeHead(302, { Location: location });
    res.end();
  }

  private securityHeaders(res: ServerResponse): void {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; img-src 'self' https://*.jtvnw.net data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'",
    );
  }
}
