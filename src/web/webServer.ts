import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AppConfig } from '../services/config.js';
import { scopedLogger } from '../services/logger.js';
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
import { dashboardHtml } from './dashboard/page.js';

const log = scopedLogger('webServer');

/**
 * The bot's HTTP surface: the dashboard landing page, the "Login with Twitch"
 * OAuth flow, and a small JSON API. Runs behind Caddy (which terminates TLS);
 * cookies are marked Secure based on config.web.publicUrl.
 */
export class WebServer {
  private server?: Server;

  constructor(
    private readonly config: AppConfig,
    private readonly relationships: ChannelRelationshipService,
  ) {}

  start(): void {
    this.server = createServer((req, res) => {
      this.handle(req, res).catch((err) => {
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
    const path = url.pathname;

    if (req.method !== 'GET') return this.send(res, 405, 'text/plain', 'Method Not Allowed');

    switch (path) {
      case '/':
        return this.securityHeaders(res).send(res, 200, 'text/html; charset=utf-8', dashboardHtml);
      case '/auth/login':
        return this.handleLogin(res);
      case '/auth/callback':
        return this.handleCallback(req, res, url);
      case '/auth/logout':
        return this.handleLogout(res);
      case '/api/me':
        return this.handleMe(req, res);
      case '/healthz':
        return this.send(res, 200, 'text/plain', 'ok');
      default:
        return this.send(res, 404, 'text/plain', 'Not Found');
    }
  }

  private handleLogin(res: ServerResponse): void {
    const state = randomState();
    const stateCookie = serializeCookie(OAUTH_STATE_COOKIE, state, {
      maxAgeSeconds: 600,
      httpOnly: true,
      secure: this.config.web.secureCookies,
      sameSite: 'Lax',
    });
    res.setHeader('Set-Cookie', stateCookie);
    this.redirect(res, buildAuthorizeUrl(this.config, state));
  }

  private async handleCallback(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    if (url.searchParams.get('error')) {
      // User denied or Twitch error — just go home.
      return this.redirect(res, '/');
    }
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const cookies = parseCookies(req.headers.cookie);
    const expectedState = cookies[OAUTH_STATE_COOKIE];

    if (!code || !state || !expectedState || state !== expectedState) {
      log.warn('OAuth callback with missing/mismatched state');
      return this.send(res, 400, 'text/plain', 'Invalid OAuth state. Please try logging in again.');
    }

    const token = await exchangeCodeForToken(this.config, code);
    const user = await fetchAuthedUser(this.config, token);
    const relationship = await this.relationships.compute(user);

    const session = signSession({ user, relationship }, this.config.web.sessionSecret);
    res.setHeader('Set-Cookie', [
      serializeCookie(SESSION_COOKIE, session, {
        maxAgeSeconds: 8 * 60 * 60,
        httpOnly: true,
        secure: this.config.web.secureCookies,
        sameSite: 'Lax',
      }),
      // Clear the one-time state cookie.
      serializeCookie(OAUTH_STATE_COOKIE, '', { maxAgeSeconds: 0, secure: this.config.web.secureCookies }),
    ]);
    log.info({ login: user.login, relationship }, 'user logged in');
    this.redirect(res, '/');
  }

  private handleLogout(res: ServerResponse): void {
    res.setHeader(
      'Set-Cookie',
      serializeCookie(SESSION_COOKIE, '', { maxAgeSeconds: 0, secure: this.config.web.secureCookies }),
    );
    this.redirect(res, '/');
  }

  private handleMe(req: IncomingMessage, res: ServerResponse): void {
    const cookies = parseCookies(req.headers.cookie);
    const session = verifySession(cookies[SESSION_COOKIE], this.config.web.sessionSecret);
    if (!session) return this.send(res, 401, 'application/json', JSON.stringify({ error: 'unauthenticated' }));
    this.send(res, 200, 'application/json', JSON.stringify(session));
  }

  // ── Response helpers ────────────────────────────────────────────────────────

  private send(res: ServerResponse, status: number, contentType: string, body: string): void {
    res.writeHead(status, { 'Content-Type': contentType });
    res.end(body);
  }

  private redirect(res: ServerResponse, location: string): void {
    res.writeHead(302, { Location: location });
    res.end();
  }

  private securityHeaders(res: ServerResponse): this {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; img-src 'self' https://*.jtvnw.net data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'",
    );
    return this;
  }
}
