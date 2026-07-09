import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { Storage } from './storage/index.js';
import { UsersService, AliasError } from './users.js';

const DB_PATH = path.resolve('prisma/basecabot.db');
const run = existsSync(DB_PATH) ? describe : describe.skip;

run('UsersService (integration)', () => {
  const A = 'itest_usersvc_a';
  const B = 'itest_usersvc_b';
  let prisma: PrismaClient;
  let users: UsersService;

  beforeAll(() => {
    prisma = new PrismaClient({ datasources: { db: { url: `file:${DB_PATH}` } } });
    users = new UsersService(new Storage(prisma));
  });

  beforeEach(async () => {
    await prisma.user.deleteMany({ where: { id: { in: [A, B] } } }); // cascade removes aliases
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: { in: [A, B] } } });
    await prisma.$disconnect();
  });

  it('syncs display name from Twitch until the user locks it', async () => {
    await users.touch({ id: A, login: 'alice', displayName: 'Alice' });
    await users.touch({ id: A, login: 'alice', displayName: 'AliceRenamed' });
    expect((await users.getById(A))?.displayName).toBe('AliceRenamed');

    await users.setDisplayName(A, 'Ali');
    await users.touch({ id: A, login: 'alice', displayName: 'ShouldNotWin' });
    expect((await users.getById(A))?.displayName).toBe('Ali');
  });

  it('rejects an empty or too-long display name', async () => {
    await users.touch({ id: A, login: 'alice', displayName: 'Alice' });
    await expect(users.setDisplayName(A, '   ')).rejects.toBeInstanceOf(AliasError);
    await expect(users.setDisplayName(A, 'x'.repeat(41))).rejects.toBeInstanceOf(AliasError);
  });

  it('adds, lists, and removes aliases', async () => {
    await users.touch({ id: A, login: 'alice', displayName: 'Alice' });
    await users.addAlias(A, 'Ace');
    await users.addAlias(A, '@TheAlmighty');
    let profile = await users.getProfile(A);
    expect(profile?.canonical).toBe('@alice');
    expect(profile?.aliases.sort()).toEqual(['@TheAlmighty', 'Ace']);

    await users.removeAlias(A, 'ace'); // normalized match, case-insensitive
    profile = await users.getProfile(A);
    expect(profile?.aliases).toEqual(['@TheAlmighty']);
  });

  it('prevents duplicate aliases across users', async () => {
    await users.touch({ id: A, login: 'alice', displayName: 'Alice' });
    await users.touch({ id: B, login: 'bob', displayName: 'Bob' });
    await users.addAlias(A, 'Shared');
    await expect(users.addAlias(B, 'shared')).rejects.toBeInstanceOf(AliasError);
  });

  it('resolves a name by login, alias, or display name', async () => {
    await users.touch({ id: A, login: 'alice', displayName: 'Alice The Great' });
    await users.addAlias(A, 'Ace');
    expect(await users.resolveNameToUserId('@alice')).toBe(A);
    expect(await users.resolveNameToUserId('ACE')).toBe(A);
    expect(await users.resolveNameToUserId('Alice The Great')).toBe(A);
    expect(await users.resolveNameToUserId('nobody')).toBeNull();
  });
});
