import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { Storage } from './storage/index.js';
import { UsersService, AliasError } from './users.js';

const DB_PATH = path.resolve('prisma/test.db'); // isolated test DB (see test/globalSetup.ts)
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

  // Regression: the chat adapter fires touch() per message while a command handler
  // may await its own, so two calls race for a brand-new user. This used to be
  // read-then-create and blew up with P2002 on `login`, failing the command.
  it('survives concurrent touches for a brand-new user (no unique-constraint race)', async () => {
    await expect(
      Promise.all([
        users.touch({ id: A, login: 'alice', displayName: 'Alice' }),
        users.touch({ id: A, login: 'alice', displayName: 'Alice' }),
        users.touch({ id: A, login: 'alice', displayName: 'Alice' }),
      ]),
    ).resolves.toBeDefined();
    expect(await prisma.user.count({ where: { id: A } })).toBe(1);
    expect((await users.getById(A))?.login).toBe('alice');
  });

  // Regression: a Twitch rename can leave a stale row holding the login another
  // account now uses. That collision must not fail the newcomer's touch forever.
  it('takes over a login held by a different user id (Twitch rename)', async () => {
    await users.touch({ id: A, login: 'shared', displayName: 'Alice' });
    await users.touch({ id: B, login: 'shared', displayName: 'Bob' }); // B now owns "shared"

    expect((await users.getById(B))?.login).toBe('shared');
    const displaced = await users.getById(A);
    expect(displaced?.login).not.toBe('shared'); // freed, placeholder is not a valid login
    expect(displaced?.login).toContain(':');

    // A self-heals to its real login the next time it is seen.
    await users.touch({ id: A, login: 'alice', displayName: 'Alice' });
    expect((await users.getById(A))?.login).toBe('alice');
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

  it('resolves a name by login, alias, or custom display name', async () => {
    await users.touch({ id: A, login: 'alice', displayName: 'Alice' });
    await users.addAlias(A, 'Ace');
    await users.setDisplayName(A, 'Alice The Great');

    expect(await users.resolveNameToUserId('@alice')).toBe(A);
    expect(await users.resolveNameToUserId('ACE')).toBe(A); // aliases are case-insensitive
    expect(await users.resolveNameToUserId('alice the great')).toBe(A); // so are display names
    expect(await users.resolveNameToUserId('nobody')).toBeNull();
  });

  // A bare name is free text if it matches nobody (a guest, "chat"), but an
  // explicit @handle asserts a real account and must fail loudly when there
  // isn't one — the two cases are what callers branch on.
  it('distinguishes an unmatched bare name from an unknown @handle', async () => {
    expect(await users.resolveUserRef('some guest')).toEqual({ kind: 'unlinked', name: 'some guest' });
    expect(await users.resolveUserRef('@ghost')).toEqual({ kind: 'unknown-handle', name: 'ghost' });
    expect(await users.resolveUserRef('   ')).toEqual({ kind: 'empty' });
  });

  // The bot only knows people who have chatted, so an @handle it has never seen
  // is looked up on Twitch and recorded rather than rejected.
  it('resolves an unseen @handle via Twitch and records the account', async () => {
    const withLookup = new UsersService(new Storage(prisma), async (login) =>
      login === 'alice' ? { id: A, login: 'alice', displayName: 'Alice' } : null,
    );
    expect(await withLookup.resolveUserRef('@alice')).toMatchObject({ kind: 'user', id: A });
    expect((await users.getById(A))?.login).toBe('alice'); // persisted
    expect(await withLookup.resolveUserRef('@ghost')).toEqual({ kind: 'unknown-handle', name: 'ghost' });
  });

  // The whole point of one global namespace: a chosen name can never stand in
  // for someone else's account, in either direction.
  it('refuses an alias or display name that another user already holds', async () => {
    await users.touch({ id: A, login: 'alice', displayName: 'Alice' });
    await users.touch({ id: B, login: 'bob', displayName: 'Bob' });

    await expect(users.addAlias(B, 'alice')).rejects.toBeInstanceOf(AliasError); // another's login
    await expect(users.setDisplayName(B, '@alice')).rejects.toBeInstanceOf(AliasError);

    await users.addAlias(A, 'Ace');
    await expect(users.setDisplayName(B, 'ace')).rejects.toBeInstanceOf(AliasError); // another's alias
    expect(await users.resolveNameToUserId('ace')).toBe(A);
  });

  // Precedence: a real Twitch account reclaims its own name from a squatter.
  it('lets a real account take back a name held as someone else\'s alias', async () => {
    await users.touch({ id: A, login: 'alice', displayName: 'Alice' });
    await users.addAlias(A, 'bob'); // nobody named bob has chatted yet
    expect(await users.resolveNameToUserId('bob')).toBe(A);

    await users.touch({ id: B, login: 'bob', displayName: 'Bob' });
    expect(await users.resolveNameToUserId('bob')).toBe(B);
    expect((await users.getProfile(A))?.aliases).not.toContain('bob');
  });

  it('drops the old indexed name when a user renames on Twitch', async () => {
    await users.touch({ id: A, login: 'alice', displayName: 'Alice' });
    await users.touch({ id: A, login: 'alicia', displayName: 'Alicia' });

    expect(await users.resolveNameToUserId('alicia')).toBe(A);
    expect(await users.resolveNameToUserId('alice')).toBeNull(); // freed for reuse
  });
});
