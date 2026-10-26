import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import { once } from 'node:events';
import { WebServer } from './webServer.js';
import type { AppConfig } from '../services/config.js';

/**
 * The control token over real HTTP. The unit tests call the guard directly, which
 * cannot catch a mistake in how the header reaches it — a wrong header name, a
 * route that never consults the guard, a body read before the check. This boots an
 * actual server on an ephemeral port and talks to it the way a Stream Deck will,
 * so the curl commands in docs/stream-deck.md are the thing under test.
 */
const TOKEN = 'control-token-0123456789';
const LIVE = {
  mode: 'regular', maxLevel: 5, pausedUntil: 0, clearedAt: 0, quiescedUntil: 0,
  slowUntil: 0, sim: false, pausedForever: false, quiescedForever: false, slowForever: false,
};

/** Only the live-control surface is stubbed; nothing else is reachable here. */
const crowd = {
  setMaxLevel: (n: number) => ({ ...LIVE, maxLevel: n }),
  slowAndPause: () => ({ ...LIVE }),
  slowAndWait: () => ({ ...LIVE }),
  clearAndPause: () => ({ ...LIVE }),
  clearAndWait: () => ({ ...LIVE }),
  quiesceAndPause: () => ({ ...LIVE }),
  quiesceAndWait: () => ({ ...LIVE }),
  resume: () => ({ ...LIVE }),
  setSim: () => ({ ...LIVE }),
};

/** The master switch and token, mutable so a test can turn the API off. */
const apiControl = { enabled: true, token: TOKEN };

let server: WebServer;
let base: string;

beforeAll(async () => {
  const config = {
    // Port 0: the OS picks a free one, so a busy port cannot make this flaky.
    web: { sessionSecret: 's'.repeat(32), publicUrl: 'http://127.0.0.1', httpPort: 0 },
    overlayToken: 'overlay-token-0123456789',
  } as unknown as AppConfig;
  const Ctor = WebServer as unknown as { new (c: AppConfig, ...rest: unknown[]): WebServer };
  server = new Ctor(config, ...Array(16).fill(undefined), crowd, apiControl);
  server.start();
  await once(server.server!, 'listening');
  base = 'http://127.0.0.1:' + (server.server!.address() as AddressInfo).port;
});

afterAll(async () => {
  await server.stop();
});

function send(p: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(base + p, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

describe('control token over HTTP', () => {
  it('performs a live action for a valid token', async () => {
    const res = await send('/api/admin/crowd/live', { action: 'max-level', level: 4 }, { 'X-Control-Token': TOKEN });
    expect(res.status).toBe(200);
    const d = (await res.json()) as { ok: boolean; live: { maxLevel: number } };
    expect(d.ok).toBe(true);
    expect(d.live.maxLevel).toBe(4);
  });

  it('matches the header case-insensitively, as HTTP requires', async () => {
    // Node lower-cases incoming header names; this fails if the lookup ever moves
    // to something case-sensitive like a raw-headers scan.
    const res = await send('/api/admin/crowd/live', { action: 'resume' }, { 'x-CoNtRoL-ToKeN': TOKEN });
    expect(res.status).toBe(200);
  });

  it('rejects a wrong token, and a missing credential, with 401', async () => {
    expect((await send('/api/admin/crowd/live', { action: 'resume' }, { 'X-Control-Token': 'wrong-token-012345678901' })).status).toBe(401);
    expect((await send('/api/admin/crowd/live', { action: 'resume' })).status).toBe(401);
  });

  it('ignores a token offered in the query string', async () => {
    const res = await fetch(base + '/api/admin/crowd/live?token=' + TOKEN, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"action":"resume"}',
    });
    expect(res.status).toBe(401);
  });

  it('refuses the token everywhere it was not opted in', async () => {
    // Config saving sits one path segment from the live actions, and user deletion
    // is the worst thing on the surface. Both must be unreachable with a token.
    const h = { 'X-Control-Token': TOKEN };
    expect((await send('/api/admin/crowd', { rows: 1 }, h)).status).toBe(401);
    expect((await send('/api/admin/crowd/seats', { seats: {} }, h)).status).toBe(401);
    expect((await send('/api/admin/users/delete', { id: '1' }, h)).status).toBe(401);
    expect((await send('/api/admin/strings', { key: 'x' }, h)).status).toBe(401);
    expect((await send('/api/admin/achievements/backfill', {}, h)).status).toBe(401);
  });

  it('still validates the action, so a typo is a 400 not a silent success', async () => {
    const res = await send('/api/admin/crowd/live', { action: 'max-levle', level: 4 }, { 'X-Control-Token': TOKEN });
    expect(res.status).toBe(400);
  });

  it('refuses a valid token the moment the master switch goes off', async () => {
    // The panic button, over the wire: same request, same token, before and after.
    const ok = await send('/api/admin/crowd/live', { action: 'resume' }, { 'X-Control-Token': TOKEN });
    expect(ok.status).toBe(200);

    apiControl.enabled = false;
    try {
      const off = await send('/api/admin/crowd/live', { action: 'resume' }, { 'X-Control-Token': TOKEN });
      expect(off.status).toBe(503);
      expect((await off.json() as { error: string }).error).toMatch(/turned off/);
    } finally {
      apiControl.enabled = true;
    }

    // And it comes straight back without a restart.
    expect((await send('/api/admin/crowd/live', { action: 'resume' }, { 'X-Control-Token': TOKEN })).status).toBe(200);
  });

  it('refuses everything once the token is removed', async () => {
    apiControl.token = '';
    try {
      const res = await send('/api/admin/crowd/live', { action: 'resume' }, { 'X-Control-Token': TOKEN });
      expect(res.status).toBe(503);
      expect((await res.json() as { error: string }).error).toMatch(/No control token/);
    } finally {
      apiControl.token = TOKEN;
    }
  });
});
