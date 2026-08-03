/** Auth routes: the Twitch OAuth login/callback/logout flow + the logged-in
 * user's own profile actions (display name, aliases). Handlers are free functions
 * that take the WebServer for its shared helpers/services; wired in webServer.ts. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { WebServer } from '../webServer.js';
import { HttpError } from '../httpShared.js';
import { scopedLogger } from '../../services/logger.js';
import { AliasError } from '../../services/users.js';
import { buildAuthorizeUrl, exchangeCodeForToken, fetchAuthedUser } from '../auth/twitchOAuth.js';
import { SESSION_COOKIE, OAUTH_STATE_COOKIE, signSession, randomState, serializeCookie, parseCookies } from '../auth/session.js';

const log = scopedLogger('webAuth');

export function handleLogin(s: WebServer, res: ServerResponse): void {
  const state = randomState();
  res.setHeader('Set-Cookie', serializeCookie(OAUTH_STATE_COOKIE, state, {
    maxAgeSeconds: 600, httpOnly: true, secure: s.config.web.secureCookies, sameSite: 'Lax',
  }));
  s.redirect(res, buildAuthorizeUrl(s.config, state));
}

export async function handleCallback(s: WebServer, req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  if (url.searchParams.get('error')) return s.redirect(res, '/');
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const expectedState = parseCookies(req.headers.cookie)[OAUTH_STATE_COOKIE];
  if (!code || !state || !expectedState || state !== expectedState) {
    log.warn('OAuth callback with missing/mismatched state');
    return s.send(res, 400, 'text/plain', 'Invalid OAuth state. Please try logging in again.');
  }

  const token = await exchangeCodeForToken(s.config, code);
  const user = await fetchAuthedUser(s.config, token);
  // Remember the user in the DB (creates the profile; keeps a custom display
  // name intact via displayNameLocked).
  await s.users.touch({ id: user.id, login: user.login, displayName: user.displayName, avatarUrl: user.avatar });
  const relationship = await s.relationships.compute(user);

  const session = signSession({ user, relationship }, s.config.web.sessionSecret);
  res.setHeader('Set-Cookie', [
    serializeCookie(SESSION_COOKIE, session, {
      maxAgeSeconds: 8 * 60 * 60, httpOnly: true, secure: s.config.web.secureCookies, sameSite: 'Lax',
    }),
    serializeCookie(OAUTH_STATE_COOKIE, '', { maxAgeSeconds: 0, secure: s.config.web.secureCookies }),
  ]);
  log.info({ login: user.login }, 'user logged in');
  s.redirect(res, '/user');
}

export function handleLogout(s: WebServer, res: ServerResponse): void {
  res.setHeader('Set-Cookie', serializeCookie(SESSION_COOKIE, '', { maxAgeSeconds: 0, secure: s.config.web.secureCookies }));
  s.redirect(res, '/');
}

export async function getMe(s: WebServer, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const session = s.getSession(req);
  if (!session) throw new HttpError(401, 'unauthenticated');
  const profile = await s.users.getProfile(session.user.id);
  s.json(res, 200, {
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

export async function postDisplayName(s: WebServer, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const session = s.requireApiSession(req);
  const body = await s.readJson(req);
  try {
    await s.users.setDisplayName(session.user.id, String(body.displayName ?? ''));
  } catch (e) {
    if (e instanceof AliasError) throw new HttpError(400, e.message);
    throw e;
  }
  const profile = await s.users.getProfile(session.user.id);
  s.json(res, 200, { displayName: profile?.displayName });
}

export async function postAlias(s: WebServer, req: IncomingMessage, res: ServerResponse, op: 'add' | 'remove'): Promise<void> {
  const session = s.requireApiSession(req);
  const body = await s.readJson(req);
  const alias = String(body.alias ?? '');
  try {
    if (op === 'add') await s.users.addAlias(session.user.id, alias);
    else await s.users.removeAlias(session.user.id, alias);
  } catch (e) {
    if (e instanceof AliasError) throw new HttpError(400, e.message);
    throw e;
  }
  const profile = await s.users.getProfile(session.user.id);
  s.json(res, 200, { aliases: profile?.aliases ?? [] });
}
