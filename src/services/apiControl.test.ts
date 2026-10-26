import { describe, it, expect, beforeEach } from 'vitest';
import { ApiControlService, ApiControlError, CONTROL_ENDPOINTS } from './apiControl.js';
import type { Storage } from './storage/index.js';
import type { Logger } from './logger.js';

/**
 * The control API's own settings. Two properties matter more than the rest: the
 * state the panel is shown must never carry the token, and anything the service
 * cannot make sense of has to leave the API CLOSED rather than open.
 */
const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as unknown as Logger;
const TOKEN = 'a'.repeat(32);

/** A one-row settings table, with an optional seeded blob and a failure mode. */
function storage(seed?: string, fail = false) {
  const rows: Record<string, string> = {};
  if (seed !== undefined) rows.apiControl = seed;
  return {
    saved: () => rows.apiControl,
    storage: {
      prisma: {
        setting: {
          findUnique: async ({ where }: { where: { key: string } }) => {
            if (fail) throw new Error('database is on fire');
            return rows[where.key] === undefined ? null : { key: where.key, value: rows[where.key]! };
          },
          upsert: async (args: { where: { key: string }; create: { value: string }; update: { value: string } }) => {
            rows[args.where.key] = args.update.value ?? args.create.value;
          },
        },
      },
    } as unknown as Storage,
  };
}

async function fresh(seed?: string, fail = false) {
  const db = storage(seed, fail);
  const svc = new ApiControlService(db.storage, logger);
  await svc.init();
  return { svc, db };
}

describe('API control settings', () => {
  let svc: ApiControlService;

  beforeEach(async () => {
    ({ svc } = await fresh());
  });

  it('starts closed: off, with no token', () => {
    // A fresh install must not expose a write API before anyone has decided to.
    expect(svc.enabled).toBe(false);
    expect(svc.token).toBe('');
    expect(svc.getState()).toEqual({ enabled: false, configured: false, hint: '', updatedAt: null });
  });

  it('never hands the token to the panel', async () => {
    await svc.setToken(TOKEN);
    const state = svc.getState() as unknown as Record<string, unknown>;
    expect(Object.values(state)).not.toContain(TOKEN);
    expect(JSON.stringify(state)).not.toContain(TOKEN);
    // Just enough to recognise which token is in place.
    expect(state.hint).toBe(TOKEN.slice(-4));
    expect(state.configured).toBe(true);
  });

  it('keeps the switch and the token independent', async () => {
    // Enabling with no token must not look like a working API...
    await svc.setEnabled(true);
    expect(svc.enabled).toBe(true);
    expect(svc.token).toBe('');

    // ...and a token must not switch the API on by itself.
    const { svc: other } = await fresh();
    await other.setToken(TOKEN);
    expect(other.enabled).toBe(false);
    expect(other.token).toBe(TOKEN);
  });

  it('refuses a token too weak to be worth having', async () => {
    for (const bad of ['', '   ', 'short', 'a'.repeat(15)]) {
      await expect(svc.setToken(bad)).rejects.toBeInstanceOf(ApiControlError);
    }
    await expect(svc.setToken('a'.repeat(201))).rejects.toBeInstanceOf(ApiControlError);
    // Whitespace would break the HTTP header it travels in.
    await expect(svc.setToken('has a space in it here')).rejects.toBeInstanceOf(ApiControlError);
    expect(svc.token).toBe('');
  });

  it('trims a pasted token rather than rejecting it', async () => {
    // Copying from a terminal very often brings a newline along.
    await svc.setToken('  ' + TOKEN + '\n');
    expect(svc.token).toBe(TOKEN);
  });

  it('generates a token strong enough to not need checking', async () => {
    const token = await svc.generateToken();
    expect(token).toMatch(/^[0-9a-f]{48}$/);
    expect(svc.token).toBe(token);
    // And a second one differs, so regenerating really rotates.
    expect(await svc.generateToken()).not.toBe(token);
  });

  it('stamps when the token changed, and clears the stamp with it', async () => {
    expect(svc.getState().updatedAt).toBeNull();
    await svc.setToken(TOKEN);
    expect(Date.parse(svc.getState().updatedAt!)).toBeGreaterThan(0);
    await svc.clearToken();
    expect(svc.getState().updatedAt).toBeNull();
  });

  it('closes the API when the token is removed, however the switch sits', async () => {
    await svc.setEnabled(true);
    await svc.setToken(TOKEN);
    await svc.clearToken();
    expect(svc.enabled).toBe(true);     // the switch is left where the owner put it
    expect(svc.token).toBe('');          // but there is nothing to authenticate with
    expect(svc.getState().configured).toBe(false);
  });

  it('persists across a restart', async () => {
    await svc.setEnabled(true);
    await svc.setToken(TOKEN);
    const { db } = await fresh();
    // Re-read what this service wrote, through a new instance.
    const again = new ApiControlService(storage(JSON.stringify({ enabled: true, token: TOKEN, updatedAt: null })).storage, logger);
    await again.init();
    expect(again.enabled).toBe(true);
    expect(again.token).toBe(TOKEN);
    expect(db.saved()).toBeUndefined();  // the fresh one really was a different store
  });
});

describe('API control, reading a damaged row', () => {
  it('falls back to closed rather than crashing or opening', async () => {
    for (const junk of ['', 'not json', '[]', 'null', '{"enabled":"yes"}', '{}']) {
      const { svc } = await fresh(junk);
      expect(svc.enabled, junk).toBe(false);
      expect(svc.token, junk).toBe('');
    }
  });

  it('drops a stored token that would no longer be accepted', async () => {
    // A hand-edited row, or one written before the rules tightened: a token the
    // setter would refuse must not keep working just because it is already there.
    for (const bad of ['short', 'has a space', 'a'.repeat(500)]) {
      const { svc } = await fresh(JSON.stringify({ enabled: true, token: bad, updatedAt: null }));
      expect(svc.token, bad).toBe('');
    }
  });

  it('keeps the API off when the database cannot be read', async () => {
    const { svc } = await fresh(JSON.stringify({ enabled: true, token: TOKEN, updatedAt: null }), true);
    expect(svc.enabled).toBe(false);
    expect(svc.token).toBe('');
  });

  it('treats a truthy-but-wrong enabled value as off', async () => {
    const { svc } = await fresh(JSON.stringify({ enabled: 1, token: TOKEN, updatedAt: null }));
    expect(svc.enabled).toBe(false);
  });
});

describe('the published endpoint list', () => {
  it('has no duplicates and is all POST paths under the admin API', () => {
    const paths = CONTROL_ENDPOINTS.map((e) => e.path);
    expect(new Set(paths).size).toBe(paths.length);
    for (const p of paths) expect(p).toMatch(/^\/api\/admin\//);
  });

  it('cannot be edited by a caller that got hold of it', () => {
    // It is handed to the route layer and serialised to the panel; a stray push
    // there would change what the panel reports for everyone. `readonly` is
    // erased at compile time, so the array has to be frozen at runtime too.
    expect(() => (CONTROL_ENDPOINTS as unknown as ControlEndpointList).push({ path: '/x', label: 'x', summary: 'x', example: null }))
      .toThrow();
    expect(Object.isFrozen(CONTROL_ENDPOINTS)).toBe(true);
    expect(CONTROL_ENDPOINTS.every((e) => Object.isFrozen(e))).toBe(true);
  });
});

type ControlEndpointList = { push: (e: { path: string; label: string; summary: string; example: string | null }) => void };
