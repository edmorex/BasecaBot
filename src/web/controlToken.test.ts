import { describe, it, expect } from 'vitest';
import type { IncomingMessage } from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { WebServer } from './webServer.js';
import { secretEquals, HttpError } from './httpShared.js';
import { signSession, SESSION_COOKIE } from './auth/session.js';
import { CONTROL_ENDPOINTS } from '../services/apiControl.js';
import type { AppConfig } from '../services/config.js';
import type { SessionData } from './auth/types.js';

/**
 * The control token: a second credential for surfaces that cannot hold a browser
 * login (a Stream Deck button, a shell script). It may write, which makes the
 * question of WHAT it can write the whole point of these tests — a stolen token
 * must not be able to delete a user or replace every text string.
 */
const SECRET = 'session-secret-for-tests';
const TOKEN = 'control-token-0123456789';
const OVERLAY = 'overlay-token-0123456789';

// `null` means no token is set. Not `undefined`: that is what a default parameter
// fills in, so passing it explicitly would quietly hand back the real token and
// the fails-closed test would pass for the wrong reason.
function server(controlToken: string | null = TOKEN, enabled = true): WebServer {
  const config = {
    web: { sessionSecret: SECRET, publicUrl: 'https://bot.test', httpPort: 0 },
    overlayToken: OVERLAY,
  } as unknown as AppConfig;
  // Only the API-control service is reachable from the guards under test; the
  // constructor just assigns its parameters, so the rest can be left out.
  const apiControl = { enabled, token: controlToken ?? '' };
  const Ctor = WebServer as unknown as { new (config: AppConfig, ...rest: unknown[]): WebServer };
  return new Ctor(config, ...Array(17).fill(undefined), apiControl);
}

function req(headers: Record<string, string | string[]> = {}): IncomingMessage {
  return { headers, url: '/api/admin/crowd/live', method: 'POST' } as unknown as IncomingMessage;
}

const ADMIN: SessionData = {
  user: { id: '1', login: 'broadcaster', displayName: 'Broadcaster', avatar: '' },
  relationship: { broadcaster: true, botAdmin: false, moderator: false, subscriber: false, follower: false },
};

function cookieFor(session: SessionData): string {
  return SESSION_COOKIE + '=' + signSession(session, SECRET);
}

/** The HttpError a call throws, or null if it did not throw one. */
function thrown(fn: () => unknown): HttpError | null {
  try {
    fn();
    return null;
  } catch (err) {
    return err instanceof HttpError ? err : null;
  }
}

describe('secretEquals', () => {
  it('accepts only an exact match', () => {
    expect(secretEquals(TOKEN, TOKEN)).toBe(true);
    expect(secretEquals(TOKEN + 'x', TOKEN)).toBe(false);
    expect(secretEquals(TOKEN.slice(0, -1), TOKEN)).toBe(false);
    // Same length, one character out: the case timingSafeEqual exists for.
    expect(secretEquals('control-token-0123456788', TOKEN)).toBe(false);
  });

  it('refuses anything that is not a single string', () => {
    // A repeated header arrives as an array; coercing it would let
    // ['control-token-0123456789'] through on its toString().
    expect(secretEquals([TOKEN], TOKEN)).toBe(false);
    expect(secretEquals([TOKEN, 'x'], TOKEN)).toBe(false);
    expect(secretEquals(undefined, TOKEN)).toBe(false);
    expect(secretEquals('', TOKEN)).toBe(false);
  });

  it('compares in constant time, which no assertion here can observe', () => {
    // A functional test cannot tell `===` from timingSafeEqual — both return the
    // same booleans — and a timing benchmark would be flaky in CI. So the
    // mechanism is pinned to the source instead: this is the one property of
    // these two guards that is invisible from the outside.
    const SHARED = readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), 'httpShared.ts'), 'utf8');
    const body = SHARED.slice(SHARED.indexOf('export function secretEquals'));
    const fn = body.slice(0, body.indexOf('\n}'));
    expect(fn).toMatch(/timingSafeEqual\(/);
    expect(fn).not.toMatch(/provided === configured|configured === provided/);

    // And both token checks have to route through it rather than comparing
    // directly — the overlay check used a plain !== before this landed.
    const SERVER = readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), 'webServer.ts'), 'utf8');
    expect(SERVER).toMatch(/if \(!secretEquals\(provided, configured\)\) throw new HttpError\(401, 'Invalid overlay token\.'\)/);
    expect(SERVER).toMatch(/if \(!secretEquals\(provided, configured\)\) throw new HttpError\(401, 'Invalid control token\.'\)/);
    expect(SERVER).not.toMatch(/provided !== configured/);
  });

  it('never throws on a length mismatch', () => {
    // timingSafeEqual throws if the buffers differ in length, which would turn a
    // wrong token into a 500 instead of a 401.
    expect(() => secretEquals('short', TOKEN)).not.toThrow();
    expect(() => secretEquals('x'.repeat(5000), TOKEN)).not.toThrow();
  });
});

describe('requireAdminOrControl', () => {
  it('authorises a valid control token without a session', () => {
    const session = server().requireAdminOrControl(req({ 'x-control-token': TOKEN }));
    expect(session.relationship.botAdmin).toBe(true);
    // Recognisably not a real Twitch user, if it ever reaches a log.
    expect(session.user.login).toBe('control-token');
    expect(session.user.id).toBe('control');
  });

  it('rejects a wrong token with 401, not a 403 or a 500', () => {
    const err = thrown(() => server().requireAdminOrControl(req({ 'x-control-token': 'nope' })));
    expect(err?.status).toBe(401);
  });

  it('fails closed when no token has been set', () => {
    // A half-finished setup must refuse the credential, not fall back to treating
    // the caller as unauthenticated and certainly not accept it.
    const err = thrown(() => server(null).requireAdminOrControl(req({ 'x-control-token': TOKEN })));
    expect(err?.status).toBe(503);
    expect(err?.message).toMatch(/No control token/);
  });

  it('refuses a VALID token while the master switch is off', () => {
    // The whole point of the switch: the credential is correct and still gets
    // nowhere, so turning the API off in the panel is a real panic button.
    const err = thrown(() => server(TOKEN, false).requireAdminOrControl(req({ 'x-control-token': TOKEN })));
    expect(err?.status).toBe(503);
    expect(err?.message).toMatch(/turned off/);
  });

  it('checks the switch before the token, so a wrong token cannot probe it', () => {
    // Both refusals are 503 while off, whatever the token: the reply must not
    // reveal whether a guessed token was the right one.
    const off = server(TOKEN, false);
    expect(thrown(() => off.requireAdminOrControl(req({ 'x-control-token': TOKEN })))?.status).toBe(503);
    expect(thrown(() => off.requireAdminOrControl(req({ 'x-control-token': 'wrong-token-012345678901' })))?.status).toBe(503);
  });

  it('still lets the broadcaster in through the browser while the API is off', () => {
    // The switch governs the token path only; it must never lock the owner out of
    // their own dashboard.
    const off = server(TOKEN, false);
    expect(off.requireAdminOrControl(req({ cookie: cookieFor(ADMIN) })).user.login).toBe('broadcaster');
  });

  it('ignores a token in the query string', () => {
    // Query secrets land in access logs, so only the header counts. The URL here
    // carries a perfectly good token and must still be refused.
    const r = { headers: {}, url: '/api/admin/crowd/live?token=' + TOKEN, method: 'POST' } as unknown as IncomingMessage;
    expect(thrown(() => server().requireAdminOrControl(r))?.status).toBe(401);
  });

  it('leaves the browser path alone', () => {
    // No header at all: behaves exactly like requireAdmin, so the admin panel is
    // unaffected by any of this.
    const s = server();
    const ok = s.requireAdminOrControl(req({ cookie: cookieFor(ADMIN) }));
    expect(ok.user.login).toBe('broadcaster');

    expect(thrown(() => s.requireAdminOrControl(req()))?.status).toBe(401);

    const viewer: SessionData = { ...ADMIN, relationship: { ...ADMIN.relationship, broadcaster: false } };
    expect(thrown(() => s.requireAdminOrControl(req({ cookie: cookieFor(viewer) })))?.status).toBe(403);
  });

  it('does not let the overlay token stand in for it, or the reverse', () => {
    // The overlay credential is read-only by design; it must not gain write
    // access just because both are static tokens on the same server.
    const s = server();
    expect(thrown(() => s.requireAdminOrControl(req({ 'x-control-token': OVERLAY })))?.status).toBe(401);

    const url = new URL('https://bot.test/api/overlay/x?token=' + TOKEN);
    expect(thrown(() => s.requireOverlayToken(req(), url))?.status).toBe(401);
  });

  it('still accepts a valid overlay token, by header or query', () => {
    const s = server();
    expect(() => s.requireOverlayToken(req(), new URL('https://bot.test/x?token=' + OVERLAY))).not.toThrow();
    expect(() => s.requireOverlayToken(req({ 'x-overlay-token': OVERLAY }), new URL('https://bot.test/x'))).not.toThrow();
    // Same length, one character out — the timing-safe path, still a 401.
    const near = OVERLAY.slice(0, -1) + '8';
    expect(thrown(() => s.requireOverlayToken(req(), new URL('https://bot.test/x?token=' + near)))?.status).toBe(401);
  });
});

/**
 * THE check this file exists for. The control token's reach is defined by which
 * handlers opt into it, so that set is pinned here: adding an eighth has to be a
 * deliberate edit to this list, with a reviewer looking at it.
 */
describe('what the control token can reach', () => {
  const ROUTES = readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), 'routes', 'adminRoutes.ts'), 'utf8');

  /** Handler names whose body calls `fn`. */
  function handlersCalling(fn: string): string[] {
    const out: string[] = [];
    for (const m of ROUTES.matchAll(/export (?:async )?function (\w+)\(/g)) {
      const start = m.index! + m[0].length;
      const next = ROUTES.indexOf('\nexport ', start);
      const body = ROUTES.slice(start, next === -1 ? undefined : next);
      if (body.includes('s.' + fn + '(req)')) out.push(m[1]!);
    }
    return out;
  }

  it('reaches exactly the live-control actions, and nothing else', () => {
    expect(handlersCalling('requireAdminOrControl').sort()).toEqual([
      'postAdminBossCancel',
      'postAdminBossSimAction',
      'postAdminBossSimSpawn',
      'postAdminBossStart',
      'postAdminCrowdLive',
      'postAdminFloofFire',
      'postAdminFloofSimulatePet',
    ]);
  });

  it('publishes exactly the endpoints it can reach, so the panel cannot under-report', () => {
    // The panel lists CONTROL_ENDPOINTS; the grants live in the handlers. Those are
    // two different places, so they are pinned to each other here. Without this a
    // handler could opt in without appearing in the panel — the broadcaster would
    // be reading an incomplete account of what their token can do.
    const granted = handlersCalling('requireAdminOrControl');
    const listed = CONTROL_ENDPOINTS.map((e) => e.path).sort();

    // Every listed path is routed, and every grant is listed. The route table maps
    // path -> handler, so compare through it.
    const SERVER = readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), 'webServer.ts'), 'utf8');
    const routedTo = new Map<string, string>();
    for (const m of SERVER.matchAll(/case '(\/api\/admin\/[\w/-]+)':\s*\n\s*return (\w+)\(/g)) {
      // The POST table wins where a path appears in both (GET is a different verb).
      if (m[2]!.startsWith('post')) routedTo.set(m[1]!, m[2]!);
    }
    for (const p of listed) {
      expect(routedTo.has(p), `${p} is listed in the panel but not routed`).toBe(true);
      expect(granted, `${p} is listed in the panel but its handler does not accept a token`).toContain(routedTo.get(p)!);
    }
    const listedHandlers = listed.map((p) => routedTo.get(p)!).sort();
    expect(listedHandlers).toEqual(granted.sort());
  });

  it('describes each published endpoint well enough to use it', () => {
    for (const e of CONTROL_ENDPOINTS) {
      expect(e.path.startsWith('/api/admin/')).toBe(true);
      expect(e.label.length).toBeGreaterThan(3);
      expect(e.summary.length).toBeGreaterThan(10);
      // An example body is either absent (the endpoint takes none) or valid JSON
      // the broadcaster can paste into curl.
      if (e.example !== null) expect(() => JSON.parse(e.example!)).not.toThrow();
    }
  });

  it('cannot touch anything destructive', () => {
    // Spelled out rather than derived: these are the handlers whose reach would
    // actually hurt, and none of them may ever accept a static token.
    const sessionOnly = handlersCalling('requireAdmin');
    for (const name of [
      'deleteAdminUser', 'updateAdminUser', 'initAdminUser',
      'postAdminString', 'postAdminAchievementBackfill', 'postAdminAchievementSimulate',
      'postAdminFloofImage', 'postAdminFloofImageDelete',
      'postAdminBossSave', 'postAdminBossDelete', 'postAdminBossImageDelete', 'postAdminBossSoundDelete',
      'postAdminCrowd', 'postAdminCrowdSeats', 'postAdminCrowdImage', 'postAdminCrowdImageDelete',
      'postAdminFloof', 'postAdminBoss', 'simulateEvent',
    ]) {
      expect(sessionOnly, `${name} must stay session-only`).toContain(name);
    }
  });

  it('keeps config saving separate from the live actions it sits beside', () => {
    // POST /api/admin/crowd (save settings) and /api/admin/crowd/live (one live
    // action) differ by a path segment. Mixing them up would hand a deck button
    // the power to rewrite every setting in the panel.
    const control = handlersCalling('requireAdminOrControl');
    expect(control).toContain('postAdminCrowdLive');
    expect(control).not.toContain('postAdminCrowd');
  });
});
