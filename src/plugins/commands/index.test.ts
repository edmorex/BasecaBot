import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { Storage } from '../../services/storage/index.js';
import { CustomCommandService } from '../../services/customCommands.js';
import { CommandRouter } from '../../core/commandRouter.js';
import { EventBus } from '../../core/eventBus.js';
import { PermissionLevel, type EventUser } from '../../core/events.js';
import type { ServiceContext } from '../../core/serviceContext.js';
import type { ChatService } from '../../services/chat.js';
import { commandsPlugin } from './index.js';

// Exercises the REAL commands plugin (fallback + alias arg handling) against the
// isolated test DB, with the real variable engine.
const DB_PATH = path.resolve('prisma/test.db');
const run = existsSync(DB_PATH) ? describe : describe.skip;

run('commands plugin — alias argument handling (integration)', () => {
  let prisma: PrismaClient;
  let svc: CustomCommandService;
  let bus: EventBus;
  let router: CommandRouter;
  let said: string[];
  const wheelAdd: string[] = [];

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: `file:${DB_PATH}` } } });
    svc = new CustomCommandService(new Storage(prisma));
    said = [];
    const chat = {
      say: async (_c: string, m: string) => void said.push(m),
      reply: vi.fn(), whisper: vi.fn(), join: vi.fn(), part: vi.fn(),
    } as unknown as ChatService;
    bus = new EventBus();
    router = new CommandRouter(bus, chat);
    svc.useReservedWords((w) => router.isRegistered(w));

    // A built-in group to alias to, capturing what `!wheel add` receives.
    router.registerGroup('wheel', {
      subcommands: { add: { handler: async (e) => void wheelAdd.push(e.argString) } },
    });

    const noop = async () => 0;
    const ctx = {
      customCommands: svc,
      commands: router,
      chat,
      bus,
      api: { users: { getUserByName: vi.fn() } },
      users: { resolveUserRef: async () => ({ kind: 'unlinked', name: '' }) },
      points: { getBalance: noop },
      quotes: {},
      lists: {},
      config: { twitch: { botUsername: 'bot', broadcasterUsername: 'chan' }, points: { name: 'points' } },
      logger: { warn() {}, debug() {}, info() {}, error() {}, child() { return this; } },
    } as unknown as ServiceContext;
    await svc.init();
    commandsPlugin().init(ctx);
  });

  beforeEach(async () => {
    await prisma.commandTrigger.deleteMany({});
    await prisma.customCommand.deleteMany({});
    await svc.init();
    said.length = 0;
    wheelAdd.length = 0;
  });

  afterAll(async () => {
    await prisma.commandTrigger.deleteMany({});
    await prisma.customCommand.deleteMany({});
    await prisma.$disconnect();
  });

  const user = (o: Partial<EventUser> = {}): EventUser => ({ id: 'u', login: 'ed', displayName: 'Ed', permission: PermissionLevel.Viewer, ...o });
  async function fire(message: string, u = user()): Promise<void> {
    await bus.publish({ type: 'chat', channel: 'c', ts: 0, message, user: u });
    await new Promise((r) => setTimeout(r, 20));
  }

  describe('custom-command aliases', () => {
    beforeEach(async () => {
      await svc.create({ kind: 'trigger', name: 'some_command' }, { response: 'a=[$(1)] b=[$(2)] all=[$(args)]' });
    });

    // The reported bug: caller args must NOT be auto-appended to the alias's args.
    it("uses the alias's args as the command's complete args (no caller append)", async () => {
      await svc.addAlias('swap', 'some_command', '$(2) $(1)');
      await fire('!swap foo bar');
      expect(said[0]).toBe('a=[bar] b=[foo] all=[bar foo]'); // not "bar foo foo bar"
    });

    it('passes NO args when the alias has none (caller args are not forwarded implicitly)', async () => {
      await svc.addAlias('plain', 'some_command');
      await fire('!plain foo bar');
      expect(said[0]).toBe('a=[] b=[] all=[]');
    });

    it('forwards the caller args only when the alias asks for them via $(args)', async () => {
      await svc.addAlias('fwd', 'some_command', 'X $(args)');
      await fire('!fwd foo bar');
      expect(said[0]).toBe('a=[X] b=[foo] all=[X foo bar]');
    });

    it('a primary trigger (not an alias) still receives the caller args', async () => {
      await fire('!some_command foo bar');
      expect(said[0]).toBe('a=[foo] b=[bar] all=[foo bar]');
    });
  });

  describe('built-in aliases', () => {
    beforeEach(() => svc.useReservedWords((w) => router.isRegistered(w)));

    it("passes the alias's baked args as the built-in's complete args", async () => {
      await svc.addAlias('addme', 'wheel', 'add $(sender)');
      await fire('!addme trailing', user({ displayName: 'Sharon' }));
      expect(wheelAdd).toEqual(['Sharon']); // 'trailing' is NOT appended
    });

    it('forwards caller args to a built-in only via $(args)', async () => {
      await svc.addAlias('addraw', 'wheel', 'add $(args)');
      await fire('!addraw hello world', user({ displayName: 'Sharon' }));
      expect(wheelAdd).toEqual(['hello world']);
    });
  });
});
