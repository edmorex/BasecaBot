import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { Storage } from './storage/index.js';
import { QuotesService, QuoteError, parseQuoteDate, formatQuote, todayIso } from './quotes.js';

// This test needs a migrated SQLite DB. Create it with:
//   DATABASE_URL="file:./basecabot.db" npx prisma migrate deploy
const DB_PATH = path.resolve('prisma/basecabot.db');
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
  const CHANNEL = 'itest_quotes_channel';
  const ADDER = { id: 'itest_quote_adder', displayName: 'Adder' };
  let prisma: PrismaClient;
  let quotes: QuotesService;

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: `file:${DB_PATH}` } } });
    quotes = new QuotesService(new Storage(prisma));
    await prisma.user.upsert({ where: { id: ADDER.id }, create: { id: ADDER.id, login: ADDER.id, displayName: ADDER.displayName }, update: {} });
  });

  beforeEach(async () => {
    await prisma.quote.deleteMany({ where: { channel: CHANNEL } });
  });

  afterAll(async () => {
    await prisma.quote.deleteMany({ where: { channel: CHANNEL } });
    await prisma.user.deleteMany({ where: { id: ADDER.id } });
    await prisma.$disconnect();
  });

  it('adds a quote with metadata, defaulting the date to today', async () => {
    const q = await quotes.add(CHANNEL, { user: '@Baseca', text: 'I meant to do that.', game: 'Elden Ring' }, ADDER);
    expect(q).toMatchObject({ user: 'Baseca', text: 'I meant to do that.', game: 'Elden Ring', date: todayIso(), quotedByName: 'Adder' });
    expect(await quotes.getById(CHANNEL, q.id)).toMatchObject({ id: q.id, user: 'Baseca' });
  });

  it('throws on unknown IDs', async () => {
    await expect(quotes.getById(CHANNEL, 999999)).rejects.toBeInstanceOf(QuoteError);
    await expect(quotes.remove(CHANNEL, 999999)).rejects.toBeInstanceOf(QuoteError);
  });

  it('edits text, user, game, and date', async () => {
    const q = await quotes.add(CHANNEL, { user: 'baseca', text: 'old' }, ADDER);
    expect((await quotes.setText(CHANNEL, q.id, 'new')).text).toBe('new');
    expect((await quotes.setUser(CHANNEL, q.id, '@someone')).user).toBe('someone');
    expect((await quotes.setGame(CHANNEL, q.id, 'Minecraft')).game).toBe('Minecraft');
    expect((await quotes.setDate(CHANNEL, q.id, '2020 06 15')).date).toBe('2020-06-15');
    await expect(quotes.setDate(CHANNEL, q.id, 'bad')).rejects.toBeInstanceOf(QuoteError);
  });

  it('returns a random quote, or null when empty', async () => {
    expect(await quotes.random(CHANNEL)).toBeNull();
    const q = await quotes.add(CHANNEL, { user: 'baseca', text: 'only one' }, ADDER);
    const r = await quotes.random(CHANNEL);
    expect(r?.id).toBe(q.id);
  });

  it('searches by text, user, game, and date', async () => {
    await quotes.add(CHANNEL, { user: 'alice', text: 'hello world', game: 'Elden Ring', date: '2024-01-02' }, ADDER);
    await quotes.add(CHANNEL, { user: 'bob', text: 'goodbye', game: 'Minecraft', date: '2024-05-06' }, ADDER);
    expect((await quotes.searchText(CHANNEL, 'hello'))?.user).toBe('alice');
    expect((await quotes.searchUser(CHANNEL, '@bob'))?.text).toBe('goodbye');
    expect((await quotes.searchGame(CHANNEL, 'minecraft'))?.user).toBe('bob');
    expect((await quotes.searchDate(CHANNEL, '2024 01 02'))?.user).toBe('alice');
    expect(await quotes.searchText(CHANNEL, 'nonexistent')).toBeNull();
  });

  it('deletes a quote', async () => {
    const q = await quotes.add(CHANNEL, { user: 'baseca', text: 'gone' }, ADDER);
    await quotes.remove(CHANNEL, q.id);
    expect(await quotes.listAllForDashboard(CHANNEL)).toHaveLength(0);
  });

  it('lists all quotes newest-ID first', async () => {
    const a = await quotes.add(CHANNEL, { user: 'x', text: 'first' }, ADDER);
    const b = await quotes.add(CHANNEL, { user: 'y', text: 'second' }, ADDER);
    const all = await quotes.listAllForDashboard(CHANNEL);
    expect(all.map((q) => q.id)).toEqual([b.id, a.id]);
  });
});
