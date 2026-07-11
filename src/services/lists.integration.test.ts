import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { Storage } from './storage/index.js';
import { ListsService, ListError } from './lists.js';

// This test needs a migrated SQLite DB. Create it with:
//   DATABASE_URL="file:./prisma/basecabot.db" npx prisma migrate dev
const DB_PATH = path.resolve('prisma/basecabot.db');
const hasDb = existsSync(DB_PATH);
const run = hasDb ? describe : describe.skip;

run('ListsService (integration)', () => {
  const CHANNEL = 'itest_lists_channel';
  const CREATOR = { id: 'itest_list_creator', displayName: 'Creator' };
  const ADDER = { id: 'itest_list_adder', displayName: 'Adder' };
  let prisma: PrismaClient;
  let lists: ListsService;

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: `file:${DB_PATH}` } } });
    lists = new ListsService(new Storage(prisma));
    for (const u of [CREATOR, ADDER]) {
      await prisma.user.upsert({ where: { id: u.id }, create: { id: u.id, login: u.id, displayName: u.displayName }, update: {} });
    }
  });

  beforeEach(async () => {
    await prisma.list.deleteMany({ where: { channel: CHANNEL } }); // cascades entries
  });

  afterAll(async () => {
    await prisma.list.deleteMany({ where: { channel: CHANNEL } });
    await prisma.user.deleteMany({ where: { id: { in: [CREATOR.id, ADDER.id] } } });
    await prisma.$disconnect();
  });

  it('creates a list with metadata and a default Moderator add-permission', async () => {
    await lists.create(CHANNEL, 'Quotes', 'Funny Quotes', CREATOR);
    const all = await lists.listAllForDashboard(CHANNEL);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ name: 'quotes', displayName: 'Funny Quotes', permission: 3, createdByName: 'Creator' });
    expect(await lists.addPermission(CHANNEL, 'quotes')).toBe(3);
  });

  it('rejects duplicate names and multi-word names', async () => {
    await lists.create(CHANNEL, 'quotes');
    await expect(lists.create(CHANNEL, 'QUOTES')).rejects.toBeInstanceOf(ListError);
    await expect(lists.create(CHANNEL, 'two words')).rejects.toBeInstanceOf(ListError);
  });

  it('adds entries with author metadata and lists them in insertion order', async () => {
    await lists.create(CHANNEL, 'quotes', undefined, CREATOR);
    await lists.addEntry(CHANNEL, 'quotes', 'first', ADDER);
    await lists.addEntry(CHANNEL, 'quotes', 'second', CREATOR);
    const list = (await lists.listAllForDashboard(CHANNEL))[0]!;
    expect(list.entries.map((e) => e.text)).toEqual(['first', 'second']);
    expect(list.entries[0]).toMatchObject({ text: 'first', addedByName: 'Adder' });
  });

  it('returns a random entry, or null when empty', async () => {
    await lists.create(CHANNEL, 'quotes');
    expect(await lists.random(CHANNEL, 'quotes')).toBeNull();
    await lists.addEntry(CHANNEL, 'quotes', 'only one', ADDER);
    expect(await lists.random(CHANNEL, 'quotes')).toBe('only one');
  });

  it('clears entries but keeps the list', async () => {
    await lists.create(CHANNEL, 'quotes');
    await lists.addEntry(CHANNEL, 'quotes', 'a', ADDER);
    await lists.addEntry(CHANNEL, 'quotes', 'b', ADDER);
    expect(await lists.clear(CHANNEL, 'quotes')).toBe(2);
    const list = (await lists.listAllForDashboard(CHANNEL))[0]!;
    expect(list.entries).toHaveLength(0);
  });

  it('renames a list, keeping its entries', async () => {
    await lists.create(CHANNEL, 'quotes');
    await lists.addEntry(CHANNEL, 'quotes', 'kept', ADDER);
    await lists.rename(CHANNEL, 'quotes', 'sayings');
    expect(await lists.exists(CHANNEL, 'quotes')).toBe(false);
    const list = (await lists.listAllForDashboard(CHANNEL))[0]!;
    expect(list.name).toBe('sayings');
    expect(list.entries.map((e) => e.text)).toEqual(['kept']);
  });

  it('updates and removes individual entries scoped to the list', async () => {
    await lists.create(CHANNEL, 'quotes');
    const en = await lists.addEntry(CHANNEL, 'quotes', 'typo', ADDER);
    await lists.updateEntry(CHANNEL, 'quotes', en.id, 'fixed');
    let list = (await lists.listAllForDashboard(CHANNEL))[0]!;
    expect(list.entries[0]!.text).toBe('fixed');
    await lists.removeEntry(CHANNEL, 'quotes', en.id);
    list = (await lists.listAllForDashboard(CHANNEL))[0]!;
    expect(list.entries).toHaveLength(0);
    await expect(lists.removeEntry(CHANNEL, 'quotes', en.id)).rejects.toBeInstanceOf(ListError);
  });

  it('deletes a list and cascades its entries', async () => {
    await lists.create(CHANNEL, 'quotes');
    await lists.addEntry(CHANNEL, 'quotes', 'gone', ADDER);
    await lists.remove(CHANNEL, 'quotes');
    expect(await lists.listAllForDashboard(CHANNEL)).toHaveLength(0);
    await expect(lists.addEntry(CHANNEL, 'quotes', 'x', ADDER)).rejects.toBeInstanceOf(ListError);
  });

  it('sets the add-permission level', async () => {
    await lists.create(CHANNEL, 'quotes');
    await lists.setPermission(CHANNEL, 'quotes', 4);
    expect(await lists.addPermission(CHANNEL, 'quotes')).toBe(4);
  });
});
