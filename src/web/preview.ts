import { createServer, type IncomingMessage } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { welcomePage } from './pages/welcome.js';
import { userPage } from './pages/user.js';
import { commandsPage } from './pages/commands.js';
import { pluginRegistry } from '../plugins/index.js';
import type { ServiceContext } from '../core/serviceContext.js';
import type { CommandHandler, CommandOptions, GroupOptions } from '../core/commandRouter.js';

/**
 * DEV-ONLY preview of the whole dashboard site. Serves the real pages with
 * MOCKED APIs (in-memory), so you can view and click through welcome / profile /
 * commands without Twitch, without the bot, and without touching production.
 *
 *   npm run preview:mod              # logged-in as a MODERATOR (can manage commands)
 *   npm run preview:viewer           # logged-in as a plain VIEWER (read-only)
 *   PREVIEW=out npm run preview:web  # logged-out (welcome page)
 *
 * (PREVIEW_USER=viewer|mod selects the identity; defaults to mod.)
 * Not imported by the bot.
 */
const PORT = Number(process.env.PORT ?? 8099);
const loggedOut = process.env.PREVIEW === 'out';
const AVATAR = (id: string) => `https://static-cdn.jtvnw.net/user-default-pictures-uv/${id}-profile_image-300x300.png`;

const PROFILES = {
  mod: {
    user: { twitchId: '101', login: 'modmandy', canonical: '@modmandy', displayName: 'ModMandy', avatar: AVATAR('998f01ae-def8-11e9-b95c-784f43822e80') },
    relationship: { broadcaster: false, botAdmin: false, moderator: true, subscriber: true, follower: true },
    aliases: ['Mandy'] as string[],
  },
  viewer: {
    user: { twitchId: '202', login: 'viewervince', canonical: '@viewervince', displayName: 'ViewerVince', avatar: AVATAR('ead5c8b2-a4c9-4724-b1dd-9f00b46cbd3d') },
    relationship: { broadcaster: false, botAdmin: false, moderator: false, subscriber: false, follower: false },
    aliases: [] as string[],
  },
};

const which: keyof typeof PROFILES = process.env.PREVIEW_USER === 'viewer' ? 'viewer' : 'mod';
const me = structuredClone(PROFILES[which]);

const mk = (o: Partial<Record<string, unknown>>) => ({
  kind: 'trigger', name: 'x', access: 0, description: 'Custom response command.', response: 'hi',
  globalCooldown: 0, userCooldown: 0, enabled: true, usageCount: 0, aliases: [] as string[], group: null as string | null, ...o,
});

/**
 * Derive the REAL built-in command list by running each plugin's init() against
 * a no-op capturing context that records register() calls. This keeps the
 * preview's built-ins (e.g. !wheel) exactly in sync with the plugins, with no
 * bot/Twitch/DB — the same way the live bot builds them from CommandRouter.list().
 */
async function collectBuiltins() {
  const captured: { name: string; description: string; usage: string; permission: number; group: string; gc: number; uc: number }[] = [];
  let currentGroup = 'other';
  const noop = () => {};
  const asyncNoop = async () => {};
  const stub = {
    commands: {
      register: (name: string, _h: CommandHandler, opts: CommandOptions = {}) =>
        captured.push({ name: name.toLowerCase(), description: opts.description ?? '', usage: opts.usage ?? '', permission: opts.permission ?? 0, group: opts.group ?? currentGroup, gc: opts.globalCooldownSeconds ?? 0, uc: opts.cooldownSeconds ?? 0 }),
      registerGroup: (name: string, opts: GroupOptions) => {
        const g = opts.group ?? currentGroup;
        captured.push({ name: name.toLowerCase(), description: opts.description ?? '', usage: '', permission: opts.permission ?? 0, group: g, gc: 0, uc: 0 });
        for (const [sub, spec] of Object.entries(opts.subcommands || {})) {
          captured.push({ name: name.toLowerCase() + ' ' + sub.toLowerCase(), description: spec.description ?? '', usage: spec.usage ?? '', permission: spec.permission ?? opts.permission ?? 0, group: g, gc: spec.globalCooldownSeconds ?? 0, uc: spec.cooldownSeconds ?? 0 });
        }
      },
      setFallback: noop,
      unregister: noop,
      setCurrentGroup: noop,
      list: () => [],
    },
    bus: { on: () => noop, onAny: () => noop, publish: asyncNoop },
    chat: { say: asyncNoop, reply: asyncNoop, whisper: asyncNoop },
    customCommands: {},
    users: {},
    points: {},
    storage: { prisma: {} },
    ws: { broadcast: noop },
    config: { twitch: { botUsername: 'bot', channels: ['preview'], admins: [] }, eventSim: { enabled: false } },
    logger: { info: noop, warn: noop, debug: noop, error: noop, child: () => ({}) },
  } as unknown as ServiceContext;

  for (const factory of pluginRegistry) {
    const plugin = factory();
    currentGroup = plugin.name;
    try {
      await plugin.init(stub);
    } catch {
      // A plugin that needs more than the stub at init is skipped; its commands
      // just won't appear in the preview.
    }
  }
  const byName = new Map(captured.map((c) => [c.name, c]));
  return [...byName.values()].map((c) =>
    mk({ kind: 'builtin', name: c.name, usage: c.usage, group: c.group, access: c.permission, description: c.description, response: null, globalCooldown: c.gc, userCooldown: c.uc }),
  );
}

// Real built-ins from the plugins + some mock custom commands (to exercise
// custom rows, phrases, silent/disabled states, and pagination).
const builtins = await collectBuiltins();
const GROUPS = ['People', 'Pets', 'Facts', null];
const mockCustoms = [
  mk({ kind: 'phrase', name: 'good game', response: 'gg!', usageCount: 12, group: 'Games' }),
  mk({ kind: 'trigger', name: 'discord', response: 'Join: discord.gg/example', aliases: ['dc'], usageCount: 42, globalCooldown: 10, userCooldown: 30, group: 'Links' }),
  // Enough to span many pages so the ellipsis pager is visible in the preview.
  ...Array.from({ length: 420 }, (_, i) =>
    mk({ name: `custom${i + 1}`, access: i % 6, response: i % 5 === 0 ? null : `Response #${i + 1}`, enabled: i % 7 !== 0, usageCount: i,
      aliases: i === 0 ? ['c1', 'first'] : [], group: GROUPS[i % 4] })),
];
const commands = [...builtins, ...mockCustoms];

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  try { return chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}; } catch { return {}; }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  const p = url.pathname;
  const html = (body: string) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(body); };
  const json = (status: number, obj: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

  if (req.method === 'GET') {
    if (p === '/') return loggedOut ? html(welcomePage()) : (res.writeHead(302, { Location: '/user' }), res.end());
    if (p === '/user') return html(userPage());
    if (p === '/commands') return html(commandsPage());
    if (p === '/api/me') return loggedOut ? json(401, { error: 'unauthenticated' }) : json(200, me);
    if (p === '/api/commands') return json(200, { commands });
    if (p.startsWith('/assets/')) {
      const name = p.slice('/assets/'.length);
      try {
        const data = await readFile(path.join(path.resolve('public'), 'assets', name));
        res.writeHead(200, { 'Content-Type': 'image/png' });
        return res.end(data);
      } catch { res.writeHead(404); return res.end('Not Found'); }
    }
    res.writeHead(404); return res.end('Not Found');
  }

  if (req.method === 'POST') {
    const body = await readJson(req);
    if (p === '/api/me/display-name') { me.user.displayName = String(body.displayName ?? me.user.displayName); return json(200, { displayName: me.user.displayName }); }
    if (p === '/api/me/aliases') { me.aliases.push(String(body.alias ?? '')); return json(200, { aliases: me.aliases }); }
    if (p === '/api/me/aliases/delete') { me.aliases = me.aliases.filter((a) => a.toLowerCase() !== String(body.alias ?? '').toLowerCase()); return json(200, { aliases: me.aliases }); }
    if (p === '/api/commands' || p === '/api/commands/delete') return json(200, { ok: true });
    res.writeHead(404); return res.end('Not Found');
  }
  res.writeHead(405); res.end('Method Not Allowed');
});

server.listen(PORT, () => {
  const who = loggedOut ? 'logged-out' : `logged-in as ${me.user.displayName} (${which})`;
  console.log(`Site preview (${who}) → http://localhost:${PORT}/`);
});
