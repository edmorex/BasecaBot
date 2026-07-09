import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { Storage } from './storage/index.js';
import { CustomCommandService, CommandError, type TargetRef } from './customCommands.js';
import { PermissionLevel } from '../core/events.js';

const DB_PATH = path.resolve('prisma/basecabot.db');
const run = existsSync(DB_PATH) ? describe : describe.skip;
const CH = 'itest_cmd';
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
    await prisma.customCommand.deleteMany({ where: { channel: CH } }); // cascades triggers
    await svc.init();
  });
  afterAll(async () => {
    await prisma.customCommand.deleteMany({ where: { channel: CH } });
    await prisma.$disconnect();
  });

  it('creates and resolves a trigger command (case-insensitive)', async () => {
    await svc.create(CH, trig('hello'), { response: 'Hi {user}!' });
    expect((await svc.findByTrigger(CH, 'HELLO'))?.response).toBe('Hi {user}!');
    expect(await svc.findByTrigger(CH, 'nope')).toBeNull();
  });

  it('rejects a duplicate trigger word', async () => {
    await svc.create(CH, trig('hello'), { response: 'a' });
    await expect(svc.create(CH, trig('hello'), { response: 'b' })).rejects.toBeInstanceOf(CommandError);
  });

  it('adds and resolves aliases; blocks collisions; blocks phrase aliases', async () => {
    await svc.create(CH, trig('hello'), { response: 'hi' });
    await svc.addAlias(CH, trig('hello'), '!hi');
    expect((await svc.findByTrigger(CH, 'hi'))?.name).toBe('hello');
    await expect(svc.addAlias(CH, trig('hello'), 'hi')).rejects.toBeInstanceOf(CommandError);

    await svc.create(CH, phrase('gg'), { response: 'good game' });
    await expect(svc.addAlias(CH, phrase('gg'), '!ggwp')).rejects.toBeInstanceOf(CommandError);
  });

  it('matches phrases (case-insensitive) only when enabled', async () => {
    await svc.create(CH, phrase('good game'), { response: 'gg!' });
    expect(svc.matchPhrases(CH, 'that was a GOOD GAME everyone').map((c) => c.name)).toEqual(['good game']);
    expect(svc.matchPhrases(CH, 'unrelated')).toEqual([]);

    await svc.setEnabled(CH, phrase('good game'), false);
    expect(svc.matchPhrases(CH, 'good game')).toEqual([]);
    await svc.setEnabled(CH, phrase('good game'), true);
    expect(svc.matchPhrases(CH, 'good game').length).toBe(1);
  });

  it('keeps user cooldown >= global cooldown', async () => {
    await svc.create(CH, trig('cd'), { response: 'x', globalCooldown: 30, userCooldown: 5 });
    let row = (await svc.listForDashboard(CH)).find((c) => c.name === 'cd')!;
    expect(row.userCooldown).toBe(30); // clamped up on create

    await svc.setCooldown(CH, trig('cd'), 60); // only global -> user clamps up to 60
    row = (await svc.listForDashboard(CH)).find((c) => c.name === 'cd')!;
    expect(row).toMatchObject({ globalCooldown: 60, userCooldown: 60 });
  });

  it('enforces enabled, permission, and cooldowns in canTrigger', async () => {
    await svc.create(CH, trig('cd'), { response: 'x', permission: PermissionLevel.Subscriber, globalCooldown: 10, userCooldown: 20 });
    const cmd = (await svc.findByTrigger(CH, 'cd'))!;
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
    await svc.create(CH, trig('bday'), { response: 'hbd' });
    let row = (await svc.listForDashboard(CH)).find((c) => c.name === 'bday')!;
    expect(row.group).toBeNull(); // ungrouped by default

    await svc.setGroup(CH, trig('bday'), '  People  ');
    row = (await svc.listForDashboard(CH)).find((c) => c.name === 'bday')!;
    expect(row.group).toBe('People');

    await svc.setGroup(CH, trig('bday'), ''); // clear
    row = (await svc.listForDashboard(CH)).find((c) => c.name === 'bday')!;
    expect(row.group).toBeNull();
  });

  it('treats an empty response as silent', async () => {
    await svc.create(CH, trig('silent'), { response: '' });
    expect((await svc.findByTrigger(CH, 'silent'))?.response).toBeNull();
  });

  it('removes a command and its triggers', async () => {
    await svc.create(CH, trig('bye'), { response: 'cya' });
    await svc.addAlias(CH, trig('bye'), '!cya');
    await svc.remove(CH, trig('bye'));
    expect(await svc.findByTrigger(CH, 'bye')).toBeNull();
    expect(await svc.findByTrigger(CH, 'cya')).toBeNull();
  });
});
