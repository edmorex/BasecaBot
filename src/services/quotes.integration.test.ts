import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { Storage } from './storage/index.js';
import { QuotesService, QuoteError, parseQuoteDate, formatQuote, todayIso } from './quotes.js';

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
    const base = { id: 5, text: 'hi', user: 'baseca', quotedByName: 'mod', createdAt: '' };
    expect(formatQuote({ ...base, game: 'Elden Ring', date: '2024-01-02' })).toBe('Quote 5: "hi" - @baseca [Elden Ring] [2024/01/02]');
    expect(formatQuote({ ...base, game: null, date: '2024-01-02' })).toBe('Quote 5: "hi" - @baseca [2024/01/02]');
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
});
