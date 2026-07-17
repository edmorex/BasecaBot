import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { Storage } from './storage/index.js';
import { ListsService, ListError } from './lists.js';

// Runs against an isolated, migrated prisma/test.db (prepared by the vitest
// global setup) so it never touches the real dev database.
const DB_PATH = path.resolve('prisma/test.db');
const hasDb = existsSync(DB_PATH);
const run = hasDb ? describe : describe.skip;

run('ListsService (integration)', () => {
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
    await prisma.list.deleteMany({}); // cascades entries
  });

  afterAll(async () => {
    await prisma.list.deleteMany({});
    await prisma.user.deleteMany({ where: { id: { in: [CREATOR.id, ADDER.id] } } });
    await prisma.$disconnect();
  });

  it('creates a list with metadata and a default Moderator add-permission', async () => {
    await lists.create('Quotes', 'Funny Quotes', CREATOR);
    const all = await lists.listAllForDashboard();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ name: 'quotes', displayName: 'Funny Quotes', permission: 3, createdByName: 'Creator' });
    expect(await lists.addPermission('quotes')).toBe(3);
  });

  it('rejects duplicate names and multi-word names', async () => {
    await lists.create('quotes');
    await expect(lists.create('QUOTES')).rejects.toBeInstanceOf(ListError);
    await expect(lists.create('two words')).rejects.toBeInstanceOf(ListError);
  });

  it('adds entries with author metadata and lists them in insertion order', async () => {
    await lists.create('quotes', undefined, CREATOR);
    await lists.addEntry('quotes', 'first', ADDER);
    await lists.addEntry('quotes', 'second', CREATOR);
    const list = (await lists.listAllForDashboard())[0]!;
    expect(list.entries.map((e) => e.text)).toEqual(['first', 'second']);
    expect(list.entries[0]).toMatchObject({ text: 'first', addedByName: 'Adder' });
  });

  it('returns a random entry, or null when empty', async () => {
    await lists.create('quotes');
    expect(await lists.random('quotes')).toBeNull();
    await lists.addEntry('quotes', 'only one', ADDER);
    expect(await lists.random('quotes')).toBe('only one');
  });

  it('clears entries but keeps the list', async () => {
    await lists.create('quotes');
    await lists.addEntry('quotes', 'a', ADDER);
    await lists.addEntry('quotes', 'b', ADDER);
    expect(await lists.clear('quotes')).toBe(2);
    const list = (await lists.listAllForDashboard())[0]!;
    expect(list.entries).toHaveLength(0);
  });

  it('renames a list, keeping its entries', async () => {
    await lists.create('quotes');
    await lists.addEntry('quotes', 'kept', ADDER);
    await lists.rename('quotes', 'sayings');
    expect(await lists.exists('quotes')).toBe(false);
    const list = (await lists.listAllForDashboard())[0]!;
    expect(list.name).toBe('sayings');
    expect(list.entries.map((e) => e.text)).toEqual(['kept']);
  });

  it('updates and removes individual entries scoped to the list', async () => {
    await lists.create('quotes');
    const en = await lists.addEntry('quotes', 'typo', ADDER);
    await lists.updateEntry('quotes', en.id, 'fixed');
    let list = (await lists.listAllForDashboard())[0]!;
    expect(list.entries[0]!.text).toBe('fixed');
    await lists.removeEntry('quotes', en.id);
    list = (await lists.listAllForDashboard())[0]!;
    expect(list.entries).toHaveLength(0);
    await expect(lists.removeEntry('quotes', en.id)).rejects.toBeInstanceOf(ListError);
  });

  it('deletes a list and cascades its entries', async () => {
    await lists.create('quotes');
    await lists.addEntry('quotes', 'gone', ADDER);
    await lists.remove('quotes');
    expect(await lists.listAllForDashboard()).toHaveLength(0);
    await expect(lists.addEntry('quotes', 'x', ADDER)).rejects.toBeInstanceOf(ListError);
  });

  it('sets the add-permission level', async () => {
    await lists.create('quotes');
    await lists.setPermission('quotes', 4);
    expect(await lists.addPermission('quotes')).toBe(4);
  });

  it('addEntries / replaceEntries bulk-import into a list', async () => {
    await lists.create('quotes');
    expect(await lists.addEntries('quotes', [{ text: 'a', addedByName: 'Bob' }, { text: '' }, { text: 'b' }])).toBe(2);
    let [list] = await lists.listAllForDashboard();
    expect(list!.entries.map((e) => e.text)).toEqual(['a', 'b']);
    expect(await lists.replaceEntries('quotes', [{ text: 'only' }])).toBe(1);
    [list] = await lists.listAllForDashboard();
    expect(list!.entries.map((e) => e.text)).toEqual(['only']);
  });

  it('replaceAllLists rebuilds the whole structure', async () => {
    await lists.create('old', 'Old One', CREATOR);
    await lists.addEntry('old', 'stale', ADDER);
    const count = await lists.replaceAllLists(
      [
        { name: 'Games', displayName: 'Completed Games', description: 'beaten', permission: 4, entries: [{ text: 'Half-Life', addedByName: 'Neo' }, { text: 'Metal Gear' }] },
        { name: 'songs', permission: 1, entries: [] },
      ],
      CREATOR,
    );
    expect(count).toBe(2);
    const all = await lists.listAllForDashboard();
    expect(all.map((l) => l.name).sort()).toEqual(['games', 'songs']);
    const games = all.find((l) => l.name === 'games')!;
    expect(games).toMatchObject({ displayName: 'Completed Games', permission: 4, createdByName: 'Creator' });
    expect(games.entries.map((e) => e.text)).toEqual(['Half-Life', 'Metal Gear']);
    expect(await lists.exists('old')).toBe(false); // wiped
  });

  it('restores creator + addedBy ids only when the user exists (FK-safe)', async () => {
    await lists.replaceAllLists(
      [
        {
          name: 'games',
          createdById: CREATOR.id,
          createdByName: 'Creator',
          entries: [
            { text: 'known', addedByName: 'Adder', addedById: ADDER.id },
            { text: 'ghost', addedByName: 'Ghost', addedById: 'itest_no_such_user' },
          ],
        },
      ],
      { id: 'itest_no_such_user', displayName: 'Importer' }, // fallback should NOT be used (list carries a creator)
    );
    const [list] = await lists.listAllForDashboard();
    expect(list!.createdById).toBe(CREATOR.id); // restored, not the importer
    expect(list!.createdByName).toBe('Creator');
    expect(list!.entries.find((e) => e.text === 'known')!.addedById).toBe(ADDER.id);
    const ghost = list!.entries.find((e) => e.text === 'ghost')!;
    expect(ghost.addedById).toBeNull(); // unknown id dropped
    expect(ghost.addedByName).toBe('Ghost'); // name preserved
  });

  it('replaceAllLists falls back to the importer only when a list carries no creator', async () => {
    await lists.replaceAllLists([{ name: 'orphan', entries: [] }], { id: CREATOR.id, displayName: 'Importer' });
    const [list] = await lists.listAllForDashboard();
    expect(list!.createdById).toBe(CREATOR.id); // fallback importer used
  });

  it('replaceAllLists preserves list + entry timestamps (true restore)', async () => {
    const lc = '2020-01-02T03:04:05.000Z';
    const lu = '2021-02-03T04:05:06.000Z';
    const ea = '2019-06-07T08:09:10.000Z';
    await lists.replaceAllLists([{ name: 'games', createdAt: lc, updatedAt: lu, entries: [{ text: 'Half-Life', addedAt: ea }] }]);
    const [l] = await lists.listAllForDashboard();
    expect(l!.createdAt).toBe(lc);
    expect(l!.updatedAt).toBe(lu);
    expect(l!.entries[0]!.addedAt).toBe(ea);
  });

  it('maxPermission reports the highest restriction', async () => {
    await lists.create('a');
    await lists.create('b');
    await lists.setPermission('b', 4);
    expect(await lists.maxPermission()).toBe(4);
  });
});
