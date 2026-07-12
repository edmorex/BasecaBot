import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { Storage } from './storage/index.js';
import { CustomCommandService, CommandError, type TargetRef } from './customCommands.js';
import { PermissionLevel } from '../core/events.js';

// Runs against an isolated, migrated prisma/test.db (prepared by the vitest
// global setup) so it never touches the real dev database.
const DB_PATH = path.resolve('prisma/test.db');
const run = existsSync(DB_PATH) ? describe : describe.skip;
const trig = (name: string): TargetRef => ({ kind: 'trigger', name });
const phrase = (name: string): TargetRef => ({ kind: 'phrase', name });

run('CustomCommandService (integration)', () => {
  let prisma: PrismaClient;
  let svc: CustomCommandService;

  beforeAll(() => {
    prisma = new PrismaClient({ datasources: { db: { url: `file:${DB_PATH}` } } });
    svc = new CustomCommandService(new Storage(prisma));
  });
  beforeEach(async () => {
    await prisma.customCommand.deleteMany({}); // cascades triggers
    await svc.init();
  });
  afterAll(async () => {
    await prisma.customCommand.deleteMany({});
    await prisma.$disconnect();
  });

  it('creates and resolves a trigger command (case-insensitive)', async () => {
    await svc.create(trig('hello'), { response: 'Hi {user}!' });
    expect((await svc.findByTrigger('HELLO'))?.response).toBe('Hi {user}!');
    expect(await svc.findByTrigger('nope')).toBeNull();
  });

  it('rejects a duplicate trigger word', async () => {
    await svc.create(trig('hello'), { response: 'a' });
    await expect(svc.create(trig('hello'), { response: 'b' })).rejects.toBeInstanceOf(CommandError);
  });

  it('adds and resolves aliases; blocks collisions; blocks phrase aliases', async () => {
    await svc.create(trig('hello'), { response: 'hi' });
    await svc.addAlias(trig('hello'), '!hi');
    expect((await svc.findByTrigger('hi'))?.name).toBe('hello');
    await expect(svc.addAlias(trig('hello'), 'hi')).rejects.toBeInstanceOf(CommandError);

    await svc.create(phrase('gg'), { response: 'good game' });
    await expect(svc.addAlias(phrase('gg'), '!ggwp')).rejects.toBeInstanceOf(CommandError);
  });

  it('matches phrases (case-insensitive) only when enabled', async () => {
    await svc.create(phrase('good game'), { response: 'gg!' });
    expect(svc.matchPhrases('that was a GOOD GAME everyone').map((c) => c.name)).toEqual(['good game']);
    expect(svc.matchPhrases('unrelated')).toEqual([]);

    await svc.setEnabled(phrase('good game'), false);
    expect(svc.matchPhrases('good game')).toEqual([]);
    await svc.setEnabled(phrase('good game'), true);
    expect(svc.matchPhrases('good game').length).toBe(1);
  });

  it('keeps user cooldown >= global cooldown', async () => {
    await svc.create(trig('cd'), { response: 'x', globalCooldown: 30, userCooldown: 5 });
    let row = (await svc.listForDashboard()).find((c) => c.name === 'cd')!;
    expect(row.userCooldown).toBe(30); // clamped up on create

    await svc.setCooldown(trig('cd'), 60); // only global -> user clamps up to 60
    row = (await svc.listForDashboard()).find((c) => c.name === 'cd')!;
    expect(row).toMatchObject({ globalCooldown: 60, userCooldown: 60 });
  });

  it('enforces enabled, permission, and cooldowns in canTrigger', async () => {
    await svc.create(trig('cd'), { response: 'x', permission: PermissionLevel.Subscriber, globalCooldown: 10, userCooldown: 20 });
    const cmd = (await svc.findByTrigger('cd'))!;
    const t0 = 1_000_000;

    expect(svc.canTrigger(cmd, 'u1', PermissionLevel.Viewer, t0)).toBe(false); // too low permission
    expect(svc.canTrigger(cmd, 'u1', PermissionLevel.Subscriber, t0)).toBe(true);

    svc.recordUse(cmd, 'u1', t0);
    expect(svc.canTrigger(cmd, 'u2', PermissionLevel.Moderator, t0 + 5_000)).toBe(false); // global cooldown blocks everyone
    expect(svc.canTrigger(cmd, 'u2', PermissionLevel.Moderator, t0 + 11_000)).toBe(true); // global elapsed
    expect(svc.canTrigger(cmd, 'u1', PermissionLevel.Subscriber, t0 + 15_000)).toBe(false); // user cooldown still active
    expect(svc.canTrigger(cmd, 'u1', PermissionLevel.Subscriber, t0 + 21_000)).toBe(true);
  });

  it('sets and clears a command group', async () => {
    await svc.create(trig('bday'), { response: 'hbd' });
    let row = (await svc.listForDashboard()).find((c) => c.name === 'bday')!;
    expect(row.group).toBeNull(); // ungrouped by default

    await svc.setGroup(trig('bday'), '  People  ');
    row = (await svc.listForDashboard()).find((c) => c.name === 'bday')!;
    expect(row.group).toBe('People');

    await svc.setGroup(trig('bday'), ''); // clear
    row = (await svc.listForDashboard()).find((c) => c.name === 'bday')!;
    expect(row.group).toBeNull();
  });

  it('blocks trigger commands/aliases that shadow built-ins (phrases allowed)', async () => {
    svc.useReservedWords((w) => w === 'wheel' || w === 'points');
    try {
      await expect(svc.create(trig('wheel'), { response: 'x' })).rejects.toBeInstanceOf(CommandError);
      await expect(svc.create(trig('WHEEL'), { response: 'x' })).rejects.toBeInstanceOf(CommandError); // normalized

      // A phrase with the same text is fine — it isn't a `!` command.
      await svc.create(phrase('wheel'), { response: 'ok' });
      expect(await svc.resolve(phrase('wheel'))).not.toBeNull();

      // Aliases are blocked too.
      await svc.create(trig('game'), { response: 'g' });
      await expect(svc.addAlias(trig('game'), '!points')).rejects.toBeInstanceOf(CommandError);
    } finally {
      svc.useReservedWords(() => false); // don't leak into other tests (shared svc)
    }
  });

  it('treats an empty response as silent', async () => {
    await svc.create(trig('silent'), { response: '' });
    expect((await svc.findByTrigger('silent'))?.response).toBeNull();
  });

  it('remove by an alias trigger removes only that alias', async () => {
    await svc.create(trig('hello'), { response: 'hi' });
    await svc.addAlias(trig('hello'), '!hi');
    await svc.addAlias(trig('hello'), '!yo');

    const res = await svc.remove(trig('hi'));
    expect(res).toEqual({ type: 'alias', alias: '!hi', command: '!hello' });
    expect(await svc.findByTrigger('hi')).toBeNull(); // alias gone
    expect((await svc.findByTrigger('hello'))?.name).toBe('hello'); // command remains
    expect((await svc.findByTrigger('yo'))?.name).toBe('hello'); // other alias remains
  });

  it('remove by the primary removes the command and reports its aliases', async () => {
    await svc.create(trig('bye'), { response: 'cya' });
    await svc.addAlias(trig('bye'), '!cya');

    const res = await svc.remove(trig('bye'));
    expect(res).toMatchObject({ type: 'command', label: '!bye', aliases: ['!cya'] });
    expect(await svc.findByTrigger('bye')).toBeNull();
    expect(await svc.findByTrigger('cya')).toBeNull(); // alias cascaded
  });
});
