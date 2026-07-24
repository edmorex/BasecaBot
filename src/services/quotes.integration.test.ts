import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { Storage } from './storage/index.js';
import { QuotesService, QuoteError, parseQuoteDate, parseQuoteAddArgs, formatQuote, todayIso } from './quotes.js';
import { UsersService } from './users.js';

// Runs against an isolated, migrated prisma/test.db (prepared by the vitest
// global setup) so it never touches the real dev database.
const DB_PATH = path.resolve('prisma/test.db');
const hasDb = existsSync(DB_PATH);
const run = hasDb ? describe : describe.skip;

describe('quote helpers (unit)', () => {
  it('parses loose date formats to YYYY-MM-DD, rejecting invalid dates', () => {
    expect(parseQuoteDate('2024 01 31')).toBe('2024-01-31');
    expect(parseQuoteDate('2024/2/9')).toBe('2024-02-09');
    expect(parseQuoteDate('2024-12-25')).toBe('2024-12-25');
    expect(parseQuoteDate('2024 02 31')).toBeNull();
    expect(parseQuoteDate('not a date')).toBeNull();
    expect(parseQuoteDate('2024 13 01')).toBeNull();
  });

  it('formats a quote for chat', () => {
    const base = { id: 5, text: 'hi', user: 'Baseca', userId: null, quotedByName: 'mod', quotedById: null, createdAt: '' };
    expect(formatQuote({ ...base, game: 'Elden Ring', date: '2024-01-02' })).toBe('Quote 5: "hi" - Baseca [Elden Ring] [2024/01/02]');
    expect(formatQuote({ ...base, game: null, date: '2024-01-02' })).toBe('Quote 5: "hi" - Baseca [2024/01/02]');
  });

  describe('parseQuoteAddArgs', () => {
    it('parses the standard "<username> <text>" form', () => {
      expect(parseQuoteAddArgs('Sharon I love pizza')).toEqual({ user: 'Sharon', text: 'I love pizza' });
      expect(parseQuoteAddArgs('  @edmo   my lemon drop soured ')).toEqual({ user: '@edmo', text: 'my lemon drop soured' });
      // Standard form doesn't start with a quote, so inner quotes are kept as text.
      expect(parseQuoteAddArgs('Sharon "quoted text"')).toEqual({ user: 'Sharon', text: '"quoted text"' });
    });

    it('parses the alternate "<text>" - <Name> form, with any/no dash whitespace', () => {
      const expected = { user: 'Sharon', text: 'I love pizza' };
      expect(parseQuoteAddArgs('"I love pizza" - Sharon')).toEqual(expected);
      expect(parseQuoteAddArgs('"I love pizza"-Sharon')).toEqual(expected);
      expect(parseQuoteAddArgs('"I love pizza" -Sharon')).toEqual(expected);
      expect(parseQuoteAddArgs('"I love pizza"- Sharon')).toEqual(expected);
    });

    it('supports a multi-word quoter name', () => {
      expect(parseQuoteAddArgs('"get fucked, dude!" - all of us')).toEqual({ user: 'all of us', text: 'get fucked, dude!' });
    });

    it('keeps a dash that appears inside the quoted text', () => {
      expect(parseQuoteAddArgs('"a quote - with a dash" - Bob')).toEqual({ user: 'Bob', text: 'a quote - with a dash' });
    });

    it('handles curly quotes and en/em dashes', () => {
      expect(parseQuoteAddArgs('“curly quote” — Ed')).toEqual({ user: 'Ed', text: 'curly quote' });
      expect(parseQuoteAddArgs('‘single curly’ – Ed')).toEqual({ user: 'Ed', text: 'single curly' });
    });

    // A leading quote signals the attributed form; anything malformed aborts
    // rather than being mis-read as "username = <opening quote word>".
    it('throws when a leading-quote input is not a valid attribution', () => {
      for (const bad of ['"just a quote, no name"', '"text" - ', '"" - Bob', '"unterminated - Bob']) {
        expect(() => parseQuoteAddArgs(bad), bad).toThrow(QuoteError);
      }
    });

    it('throws when the standard form is missing text', () => {
      expect(() => parseQuoteAddArgs('Sharon')).toThrow(QuoteError);
      expect(() => parseQuoteAddArgs('   ')).toThrow(QuoteError);
    });
  });
});

run('QuotesService (integration)', () => {
  const ADDER = { id: 'itest_quote_adder', displayName: 'Adder' };
  let prisma: PrismaClient;
  let quotes: QuotesService;

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: `file:${DB_PATH}` } } });
    quotes = new QuotesService(new Storage(prisma));
    await prisma.user.upsert({ where: { id: ADDER.id }, create: { id: ADDER.id, login: ADDER.id, displayName: ADDER.displayName }, update: {} });
  });

  beforeEach(async () => {
    await prisma.quote.deleteMany({});
  });

  afterAll(async () => {
    await prisma.quote.deleteMany({});
    await prisma.user.deleteMany({ where: { id: ADDER.id } });
    await prisma.$disconnect();
  });

  it('adds a quote with metadata, defaulting the date to today', async () => {
    const q = await quotes.add({ user: '@Baseca', text: 'I meant to do that.', game: 'Elden Ring' }, ADDER);
    expect(q).toMatchObject({ user: 'Baseca', text: 'I meant to do that.', game: 'Elden Ring', date: todayIso(), quotedByName: 'Adder' });
    expect(await quotes.getById(q.id)).toMatchObject({ id: q.id, user: 'Baseca' });
  });

  it('throws on unknown IDs', async () => {
    await expect(quotes.getById(999999)).rejects.toBeInstanceOf(QuoteError);
    await expect(quotes.remove(999999)).rejects.toBeInstanceOf(QuoteError);
  });

  it('edits text, user, game, and date', async () => {
    const q = await quotes.add({ user: 'baseca', text: 'old' }, ADDER);
    expect((await quotes.setText(q.id, 'new')).text).toBe('new');
    expect((await quotes.setUser(q.id, '@someone')).user).toBe('someone');
    expect((await quotes.setGame(q.id, 'Minecraft')).game).toBe('Minecraft');
    expect((await quotes.setDate(q.id, '2020 06 15')).date).toBe('2020-06-15');
    await expect(quotes.setDate(q.id, 'bad')).rejects.toBeInstanceOf(QuoteError);
  });

  it('returns a random quote, or null when empty', async () => {
    expect(await quotes.random()).toBeNull();
    const q = await quotes.add({ user: 'baseca', text: 'only one' }, ADDER);
    const r = await quotes.random();
    expect(r?.id).toBe(q.id);
  });

  it('searches by text, user, game, and date', async () => {
    await quotes.add({ user: 'alice', text: 'hello world', game: 'Elden Ring', date: '2024-01-02' }, ADDER);
    await quotes.add({ user: 'bob', text: 'goodbye', game: 'Minecraft', date: '2024-05-06' }, ADDER);
    expect((await quotes.searchText('hello'))?.user).toBe('alice');
    expect((await quotes.searchUser('@bob'))?.text).toBe('goodbye');
    expect((await quotes.searchGame('minecraft'))?.user).toBe('bob');
    expect((await quotes.searchDate('2024 01 02'))?.user).toBe('alice');
    expect(await quotes.searchText('nonexistent')).toBeNull();
  });

  it('deletes a quote', async () => {
    const q = await quotes.add({ user: 'baseca', text: 'gone' }, ADDER);
    await quotes.remove(q.id);
    expect(await quotes.listAllForDashboard()).toHaveLength(0);
  });

  it('lists all quotes newest-ID first', async () => {
    const a = await quotes.add({ user: 'x', text: 'first' }, ADDER);
    const b = await quotes.add({ user: 'y', text: 'second' }, ADDER);
    const all = await quotes.listAllForDashboard();
    expect(all.map((q) => q.id)).toEqual([b.id, a.id]);
  });

  it('bulkImport adds valid rows, skips blanks, and defaults the date', async () => {
    const added = await quotes.bulkImport([
      { text: 'hello', user: '@Baseca', game: 'Elden Ring', date: '2024-01-02', quotedByName: 'Mod' },
      { text: '', user: 'x' }, // skipped (no text)
      { text: 'no user', user: '' }, // skipped (no user)
      { text: 'defaults', user: 'alice' }, // date defaults to today
    ]);
    expect(added).toBe(2);
    const all = await quotes.listAllForDashboard();
    expect(all).toHaveLength(2);
    expect(all.find((q) => q.text === 'hello')).toMatchObject({ user: 'Baseca', game: 'Elden Ring', date: '2024-01-02', quotedByName: 'Mod' });
    expect(all.find((q) => q.text === 'defaults')!.date).toBe(todayIso());
  });

  it('restores quotedById only when that user exists (FK-safe)', async () => {
    await quotes.bulkImport([
      { text: 'known adder', user: 'a', quotedByName: 'Adder', quotedById: ADDER.id },
      { text: 'ghost adder', user: 'b', quotedByName: 'Ghost', quotedById: 'itest_no_such_user' },
    ]);
    const all = await quotes.listAllForDashboard();
    expect(all.find((q) => q.text === 'known adder')!.quotedById).toBe(ADDER.id); // restored
    const ghost = all.find((q) => q.text === 'ghost adder')!;
    expect(ghost.quotedById).toBeNull(); // unknown id dropped
    expect(ghost.quotedByName).toBe('Ghost'); // name preserved
  });

  it('replaceAllWith wipes then inserts (atomic)', async () => {
    await quotes.add({ user: 'old', text: 'old quote' }, ADDER);
    const added = await quotes.replaceAllWith([{ text: 'brand new', user: 'neo' }]);
    expect(added).toBe(1);
    const all = await quotes.listAllForDashboard();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ text: 'brand new', user: 'neo' });
  });

  it('replaceAllWith preserves the quote id + createdAt (true restore)', async () => {
    const createdAt = '2020-05-06T07:08:09.000Z';
    await quotes.replaceAllWith([{ id: 4242, text: 'restored', user: 'neo', date: '2019-01-02', createdAt }]);
    const all = await quotes.listAllForDashboard();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ id: 4242, text: 'restored', date: '2019-01-02', createdAt });
  });

  it('additive import ignores ids (no primary-key conflict)', async () => {
    const q = await quotes.add({ user: 'x', text: 'seed' }, ADDER);
    await expect(quotes.bulkImport([{ id: q.id, text: 'new', user: 'y' }])).resolves.toBe(1);
    expect(await quotes.listAllForDashboard()).toHaveLength(2);
  });
});

// Attribution through the identity layer: any of a person's names resolves to
// them, and what's displayed tracks their current display name.
run('QuotesService attribution (integration)', () => {
  const SPEAKER = 'itest_quote_speaker';
  const ADDER = { id: 'itest_quote_adder2', displayName: 'Adder' };
  let prisma: PrismaClient;
  let quotes: QuotesService;
  let users: UsersService;

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: `file:${DB_PATH}` } } });
    const storage = new Storage(prisma);
    users = new UsersService(storage);
    quotes = new QuotesService(storage, users);
    await prisma.user.upsert({ where: { id: ADDER.id }, create: { id: ADDER.id, login: ADDER.id, displayName: ADDER.displayName }, update: {} });
  });

  beforeEach(async () => {
    await prisma.quote.deleteMany({});
    await prisma.user.deleteMany({ where: { id: SPEAKER } });
    await users.touch({ id: SPEAKER, login: 'speaker', displayName: 'Speaker' });
  });

  afterAll(async () => {
    await prisma.quote.deleteMany({});
    await prisma.user.deleteMany({ where: { id: { in: [SPEAKER, ADDER.id] } } });
    await prisma.$disconnect();
  });

  it('links a quote added under any of the speaker\'s names', async () => {
    await users.addAlias(SPEAKER, 'Speedy');
    for (const name of ['@speaker', 'speaker', 'Speedy']) {
      const q = await quotes.add({ user: name, text: `via ${name}` }, ADDER);
      expect(q.userId).toBe(SPEAKER);
      expect(q.user).toBe('Speaker'); // always displayed as the display name
    }
  });

  it('shows the current display name on old quotes after a rename', async () => {
    const q = await quotes.add({ user: '@speaker', text: 'timeless' }, ADDER);
    await users.setDisplayName(SPEAKER, 'The Speaker');
    expect((await quotes.getById(q.id)).user).toBe('The Speaker');
  });

  // "Quoted By" is a display name too. A CSV restore snapshots whatever the file
  // held (an import stored logins), so the adder must render from the linked
  // account rather than that stored string.
  it('shows the adder\'s current display name, not the stored snapshot', async () => {
    await prisma.quote.create({
      data: { text: 'imported', quotedUser: 'Speaker', quotedUserId: SPEAKER, quoteDate: '2026-01-01', createdById: ADDER.id, createdByName: 'itest_quote_adder2' },
    });
    const [view] = await quotes.listAllForDashboard();
    expect(view?.quotedByName).toBe('Adder'); // the account's display name, not the login
    expect(view?.user).toBe('Speaker');

    await users.setDisplayName(ADDER.id, 'Renamed Adder');
    expect((await quotes.listAllForDashboard())[0]?.quotedByName).toBe('Renamed Adder');
    await users.setDisplayName(ADDER.id, 'Adder');
  });

  it('falls back to the snapshot when the adder has no account', async () => {
    await prisma.quote.create({
      data: { text: 'orphan', quotedUser: 'a guest', quoteDate: '2026-01-01', createdById: null, createdByName: 'someone' },
    });
    const [view] = await quotes.listAllForDashboard();
    expect(view?.quotedByName).toBe('someone');
  });

  it('keeps an unmatched name as free text, but rejects an unknown @handle', async () => {
    const q = await quotes.add({ user: 'a caller', text: 'guest bit' }, ADDER);
    expect(q.userId).toBeNull();
    expect(q.user).toBe('a caller');
    await expect(quotes.add({ user: '@nosuchaccount', text: 'x' }, ADDER)).rejects.toBeInstanceOf(QuoteError);
  });

  it('finds a linked quote by any name, and unlinked ones by their snapshot', async () => {
    await users.addAlias(SPEAKER, 'Speedy');
    await quotes.add({ user: '@speaker', text: 'linked' }, ADDER);
    await quotes.add({ user: 'a caller', text: 'unlinked' }, ADDER);

    expect(await quotes.searchUser('Speedy')).toMatchObject({ text: 'linked' });
    expect(await quotes.searchUser('a caller')).toMatchObject({ text: 'unlinked' });
    expect(await quotes.searchUser('nobody at all')).toBeNull();
  });

  it('counts quotes: total, by text search, and by user', async () => {
    await users.addAlias(SPEAKER, 'Speedy');
    await quotes.add({ user: '@speaker', text: 'I love pizza' }, ADDER);
    await quotes.add({ user: '@speaker', text: 'pizza again' }, ADDER);
    await quotes.add({ user: 'a caller', text: 'no food here' }, ADDER);

    expect(await quotes.count()).toBe(3);
    expect(await quotes.countText('pizza')).toBe(2);
    expect(await quotes.countText('nothing')).toBe(0);
    expect(await quotes.countUser('Speedy')).toBe(2); // linked, resolved via alias
    expect(await quotes.countUser('a caller')).toBe(1); // unlinked snapshot
    await expect(quotes.countText('   ')).rejects.toBeInstanceOf(QuoteError); // blank term
  });

  // Regression: searching a user whose display name is a SUBSTRING of another
  // person's attributed name must not leak the other person's quotes. ("Ed" is
  // a substring of "Teledahn"; searchUser once did a `contains` on the display
  // name and pulled Teledahn quotes in.)
  it('does not match a user whose display name is a substring of another attribution', async () => {
    const ED = 'itest_quote_ed';
    await prisma.user.deleteMany({ where: { id: ED } });
    await users.touch({ id: ED, login: 'edmorex', displayName: 'Edmorex' });
    await users.setDisplayName(ED, 'Ed'); // a CUSTOM display name — indexed + resolvable
    await users.addAlias(ED, 'edmo');

    await quotes.add({ user: '@edmorex', text: 'the ed quote' }, ADDER);   // linked to Ed
    await quotes.add({ user: 'Teledahn', text: 'the teledahn quote' }, ADDER); // unlinked; "Teledahn" contains "ed"

    // Every one of Ed's indexed names resolves to him and returns ONLY his
    // quote — never Teledahn's, even though "Ed" is a substring of "Teledahn".
    for (const name of ['edmorex', 'edmo', 'Ed', '@edmorex']) {
      const q = await quotes.searchUser(name);
      expect(q?.text, `search "${name}"`).toBe('the ed quote');
    }
    await prisma.user.deleteMany({ where: { id: ED } });
  });
});
