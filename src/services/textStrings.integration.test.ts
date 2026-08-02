import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { Storage } from './storage/index.js';
import { TextStringsService, interpolate } from './textStrings.js';

const DB_PATH = path.resolve('prisma/test.db');
const hasDb = existsSync(DB_PATH);
const run = hasDb ? describe : describe.skip;

describe('interpolate (unit)', () => {
  it('substitutes {tokens} and leaves unknown ones intact', () => {
    expect(interpolate('Hi {user}, {n} subs!', { user: 'Ed', n: 3 })).toBe('Hi Ed, 3 subs!');
    expect(interpolate('{a} and {b}', { a: 'x' })).toBe('x and {b}');
    expect(interpolate('no tokens', {})).toBe('no tokens');
  });
});

run('TextStringsService (integration)', () => {
  let prisma: PrismaClient;
  let text: TextStringsService;

  const seed = (t: TextStringsService) => {
    t.register({ feature: 'events', key: 'sub', label: 'Subscription', default: 'Thanks {user}!', placeholders: ['user'] });
    t.register({ feature: 'events', key: 'raid', label: 'Raid', default: '{from} raided with {viewers}!', placeholders: ['from', 'viewers'] });
    t.register({ feature: 'first', key: 'win', default: '{user} was FIRST' });
  };

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: `file:${DB_PATH}` } } });
  });

  beforeEach(async () => {
    await prisma.textString.deleteMany({});
    text = new TextStringsService(new Storage(prisma));
    await text.init();
    seed(text);
  });

  afterAll(async () => {
    await prisma.textString.deleteMany({});
    await prisma.$disconnect();
  });

  it('returns the registered default until overridden', () => {
    expect(text.get('events', 'sub')).toBe('Thanks {user}!');
    expect(text.format('events', 'sub', { user: 'Ed' })).toBe('Thanks Ed!');
    expect(text.get('events', 'nope')).toBe(''); // unregistered
  });

  it('persists an override and serves it (live, same instance)', async () => {
    await text.set('events', 'sub', 'yo {user} 💜');
    expect(text.get('events', 'sub')).toBe('yo {user} 💜');
    expect(text.format('events', 'sub', { user: 'Ed' })).toBe('yo Ed 💜');
    expect(await prisma.textString.findUnique({ where: { feature_key: { feature: 'events', key: 'sub' } } })).toMatchObject({ value: 'yo {user} 💜' });
  });

  it('loads overrides on init (survives a restart)', async () => {
    await text.set('events', 'raid', 'INCOMING {from}');
    const fresh = new TextStringsService(new Storage(prisma));
    await fresh.init();
    seed(fresh);
    expect(fresh.get('events', 'raid')).toBe('INCOMING {from}');
    expect(fresh.get('events', 'sub')).toBe('Thanks {user}!'); // untouched → default
  });

  it('resets an override back to the default', async () => {
    await text.set('events', 'sub', 'custom');
    await text.reset('events', 'sub');
    expect(text.get('events', 'sub')).toBe('Thanks {user}!');
    expect(await prisma.textString.findMany({})).toHaveLength(0);
  });

  it('lists registered strings grouped by feature, flagging customized ones', async () => {
    await text.set('events', 'sub', 'custom sub');
    const groups = text.list();
    expect(groups.map((g) => g.feature)).toEqual(['events', 'first']); // registration order
    const events = groups[0]!;
    expect(events.strings.map((s) => s.key)).toEqual(['sub', 'raid']);
    expect(events.strings[0]).toMatchObject({ label: 'Subscription', value: 'custom sub', default: 'Thanks {user}!', custom: true });
    expect(events.strings[1]).toMatchObject({ key: 'raid', custom: false, placeholders: ['from', 'viewers'] });
    // A def without a label falls back to its key.
    expect(groups[1]!.strings[0]).toMatchObject({ key: 'win', label: 'win' });
  });
});
