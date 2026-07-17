import { createServer, type IncomingMessage } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { welcomePage } from './pages/welcome.js';
import { userPage } from './pages/user.js';
import { commandsPage } from './pages/commands.js';
import { listsPage } from './pages/lists.js';
import { quotesPage } from './pages/quotes.js';
import { toCsv, parseCsv, mapCsvRows, QUOTE_CSV_SPEC, LIST_CSV_SPEC, COMMAND_CSV_SPEC } from '../services/csv.js';
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
  globalCooldown: 0, userCooldown: 0, enabled: true, usageCount: 0, group: null as string | null,
  target: null as string | null, args: null as string | null,
  createdAt: '2026-06-01T12:00:00.000Z' as string | null, updatedAt: '2026-06-15T09:30:00.000Z' as string | null, ...o,
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
    lists: {},
    quotes: {},
    users: {},
    points: {},
    storage: { prisma: {} },
    ws: { broadcast: noop },
    config: { twitch: { botUsername: 'bot', channel: 'preview', broadcasterUsername: 'preview', admins: [] }, points: { name: 'points' }, eventSim: { enabled: false } },
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
  mk({ kind: 'trigger', name: 'discord', response: 'Join: discord.gg/example', usageCount: 42, globalCooldown: 10, userCooldown: 30, group: 'Links' }),
  // An alias row: mirrors discord's access/uses/cooldown/group; Response shows its target.
  mk({ kind: 'alias', name: 'dc', target: 'discord', args: null, usageCount: 42, globalCooldown: 10, userCooldown: 30, group: 'Links', response: null }),
  mk({ kind: 'trigger', name: 'roll', response: 'You rolled $(1)', usageCount: 8, group: 'Fun' }),
  mk({ kind: 'alias', name: 'd6', target: 'roll', args: '$(random 1-6)', usageCount: 8, group: 'Fun', response: null, enabled: false }),
  // Enough to span many pages so the ellipsis pager is visible in the preview.
  ...Array.from({ length: 420 }, (_, i) =>
    mk({ name: `custom${i + 1}`, access: i % 6, response: i % 5 === 0 ? null : `Response #${i + 1}`, enabled: i % 7 !== 0, usageCount: i, group: GROUPS[i % 4] })),
];
const commands = [...builtins, ...mockCustoms];

// Mock named lists (exercises the sidebar, entries table, and permission gating).
interface MockEntry { id: number; text: string; addedByName: string | null; addedAt: string }
interface MockList { name: string; displayName: string | null; description: string | null; permission: number; createdByName: string | null; createdAt: string; entries: MockEntry[] }
let mockEntryId = 1000;
const iso = (daysAgo: number) => new Date(Date.now() - daysAgo * 86400000).toISOString();
const entry = (text: string, by: string, daysAgo: number): MockEntry => ({ id: mockEntryId++, text, addedByName: by, addedAt: iso(daysAgo) });
const mockLists: MockList[] = [
  {
    name: 'quotes', displayName: 'Funny Quotes', description: 'Memorable things said on stream.', permission: 3,
    createdByName: 'Baseca', createdAt: iso(40),
    entries: [entry('"I meant to do that." — Baseca, falling off a cliff', 'ModMandy', 30), entry('"gg ez" (narrator: it was not ez)', 'ViewerVince', 12), entry('"Trust me, I\'m an engineer."', 'Baseca', 3)],
  },
  {
    name: 'songs', displayName: 'Song Requests', description: 'Community song suggestions — subs and up can add.', permission: 1,
    createdByName: 'ModMandy', createdAt: iso(20),
    entries: [entry('Darude - Sandstorm', 'ViewerVince', 5), entry('Rick Astley - Never Gonna Give You Up', 'ModMandy', 4)],
  },
  {
    name: 'secrets', displayName: 'Broadcaster Notes', description: 'Only the broadcaster can touch this one.', permission: 4,
    createdByName: 'Baseca', createdAt: iso(2),
    entries: [entry('Remember to plug the merch at the end.', 'Baseca', 2)],
  },
];
const listByName = (n: string) => mockLists.find((l) => l.name === String(n).toLowerCase().replace(/^!/, '').trim());

// Mock quotes (exercises the searchable table + pagination).
interface MockQuote { id: number; text: string; user: string; game: string | null; date: string; quotedByName: string | null; createdAt: string }
const dISO = (daysAgo: number) => new Date(Date.now() - daysAgo * 86400000).toISOString().slice(0, 10);
const GAMES = ['Just Chatting', 'Elden Ring', 'Minecraft', 'VALORANT', null];
const SAID_BY = ['Baseca', 'ViewerVince', 'ModMandy', 'SubSam'];
const mockQuotes: MockQuote[] = Array.from({ length: 63 }, (_, i) => ({
  id: i + 1,
  text: i === 0 ? 'I meant to do that.' : i === 1 ? 'gg ez (it was not ez)' : `Sample quote number ${i + 1} that someone said on stream.`,
  user: SAID_BY[i % SAID_BY.length]!,
  game: GAMES[i % GAMES.length] ?? null,
  date: dISO((i * 5) % 400),
  quotedByName: SAID_BY[(i + 1) % SAID_BY.length]!,
  createdAt: new Date(Date.now() - i * 86400000).toISOString(),
}));

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
  const csv = (text: string) => { res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8' }); res.end(text); };
  const LVL = ['Everyone', 'Subscriber', 'VIP', 'Moderator', 'Broadcaster', 'Admin'];

  if (req.method === 'GET') {
    if (p === '/') return html(welcomePage());
    if (p === '/user') return html(userPage());
    if (p === '/commands') return html(commandsPage());
    if (p === '/lists') return html(listsPage());
    if (p === '/quotes') return html(quotesPage());
    if (p === '/api/me') return loggedOut ? json(401, { error: 'unauthenticated' }) : json(200, me);
    if (p === '/api/commands') return json(200, { commands });
    if (p === '/api/commands/export') {
      const rows: (string | number)[][] = [['Type', 'Name', 'Response', 'Group', 'Access', 'Enabled', 'Global Cooldown', 'User Cooldown', 'Uses', 'Target', 'Args', 'Created At', 'Updated At']];
      for (const c of commands.filter((c) => c.kind !== 'builtin')) {
        rows.push([c.kind, c.name, c.response ?? '', c.group ?? '', LVL[c.access] ?? String(c.access), c.enabled ? 'true' : 'false', c.globalCooldown, c.userCooldown, c.usageCount, c.target ?? '', c.args ?? '', c.kind === 'alias' ? '' : (c.createdAt ?? ''), c.kind === 'alias' ? '' : (c.updatedAt ?? '')]);
      }
      return csv(toCsv(rows));
    }
    if (p === '/api/lists') return json(200, { lists: mockLists });
    if (p === '/api/quotes') return json(200, { quotes: mockQuotes });
    if (p === '/api/quotes/export') {
      const rows: (string | number)[][] = [['ID', 'Quote', 'User', 'Game', 'Date', 'Quoted By', 'Quoted By ID', 'Created At'], ...mockQuotes.map((q) => [q.id, q.text, q.user, q.game ?? '', q.date, q.quotedByName ?? '', '', q.createdAt])];
      return csv(toCsv(rows));
    }
    if (p === '/api/lists/export') {
      const scope = url.searchParams.get('scope') === 'active' ? 'active' : 'all';
      const only = (url.searchParams.get('list') ?? '').toLowerCase();
      const rows: (string | number)[][] = [['List', 'Display Name', 'Description', 'Permission', 'Created By', 'Created By ID', 'List Created At', 'List Updated At', 'Entry', 'Added By', 'Added By ID', 'Date Added']];
      for (const l of mockLists.filter((l) => scope === 'all' || l.name === only)) {
        const meta = [l.name, l.displayName ?? '', l.description ?? '', LVL[l.permission] ?? String(l.permission), l.createdByName ?? '', '', l.createdAt, l.createdAt];
        if (l.entries.length === 0) rows.push([...meta, '', '', '', '']);
        else for (const e of l.entries) rows.push([...meta, e.text, e.addedByName ?? '', '', e.addedAt]);
      }
      return csv(toCsv(rows));
    }
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
    if (p === '/api/commands/create') {
      const kind = body.kind === 'phrase' ? 'phrase' : 'trigger';
      const name = kind === 'trigger' ? String(body.name ?? '').replace(/^!/, '').toLowerCase().trim() : String(body.name ?? '').trim();
      if (name) {
        commands.push(mk({
          kind, name, access: Number(body.permission) || 0,
          response: body.response == null ? null : String(body.response),
          group: body.group ? String(body.group) : null,
          enabled: body.enabled !== false,
          globalCooldown: Number(body.globalCooldown) || 0, userCooldown: Number(body.userCooldown) || 0,
        }));
      }
      return json(200, { ok: true });
    }
    if (p === '/api/commands/alias') {
      const word = String(body.alias ?? '').replace(/^!/, '').toLowerCase().trim();
      const targetName = String(body.target ?? '').replace(/^!/, '').toLowerCase().trim();
      const cmd = commands.find((c) => c.kind === 'trigger' && c.name === targetName);
      if (word && cmd) {
        commands.push(mk({ kind: 'alias', name: word, target: cmd.name, args: body.args ? String(body.args) : null, access: cmd.access, group: cmd.group, globalCooldown: cmd.globalCooldown, userCooldown: cmd.userCooldown, usageCount: cmd.usageCount, response: null }));
      }
      return json(200, { ok: true });
    }
    if (p === '/api/commands/alias/update') {
      const word = String(body.alias ?? '').replace(/^!/, '').toLowerCase().trim();
      const a = commands.find((c) => c.kind === 'alias' && c.name === word);
      if (a) {
        if ('target' in body) { const t = commands.find((c) => c.kind === 'trigger' && c.name === String(body.target ?? '').replace(/^!/, '').toLowerCase().trim()); if (t) { a.target = t.name; a.access = t.access; a.group = t.group; a.globalCooldown = t.globalCooldown; a.userCooldown = t.userCooldown; a.usageCount = t.usageCount; } }
        if ('args' in body) a.args = body.args ? String(body.args) : null;
        if ('enabled' in body) a.enabled = Boolean(body.enabled);
      }
      return json(200, { ok: true });
    }
    if (p === '/api/commands/alias/delete') {
      const word = String(body.alias ?? '').replace(/^!/, '').toLowerCase().trim();
      const i = commands.findIndex((c) => c.kind === 'alias' && c.name === word);
      if (i >= 0) commands.splice(i, 1);
      return json(200, { ok: true });
    }
    if (p === '/api/commands/import') {
      const items = mapCsvRows(parseCsv(String(body.csv ?? '')), COMMAND_CSV_SPEC);
      const toLevel = (s: string) => { const i = LVL.findIndex((l) => l.toLowerCase() === String(s || '').toLowerCase()); return i >= 0 ? i : 0; };
      const isOn = (s: string) => !/^(false|no|0|off|disabled)$/i.test(String(s || '').trim());
      const has = (n: string) => commands.some((c) => c.name === n && c.kind !== 'builtin');
      if (body.mode === 'replace') for (let i = commands.length - 1; i >= 0; i--) if (commands[i]!.kind !== 'builtin') commands.splice(i, 1);
      let cmds = 0, aliases = 0, skipped = 0;
      for (const m of items) {
        const type = (m.type ?? '').toLowerCase();
        if (type === 'alias') continue;
        const kind = type === 'phrase' ? 'phrase' : 'trigger';
        const name = kind === 'trigger' ? String(m.name ?? '').replace(/^!/, '').toLowerCase().trim() : String(m.name ?? '').trim();
        if (!name || has(name)) { skipped++; continue; }
        commands.push(mk({ kind, name, response: m.response || null, group: m.group || null, access: toLevel(m.access ?? ''), enabled: isOn(m.enabled ?? ''), globalCooldown: Number(m.globalCooldown) || 0, userCooldown: Number(m.userCooldown) || 0, usageCount: Number(m.usageCount) || 0 }));
        cmds++;
      }
      for (const m of items) {
        if ((m.type ?? '').toLowerCase() !== 'alias') continue;
        const name = String(m.name ?? '').replace(/^!/, '').toLowerCase().trim();
        const target = String(m.target ?? '').replace(/^!/, '').toLowerCase().trim();
        const t = commands.find((c) => c.kind === 'trigger' && c.name === target);
        if (!name || !t || has(name)) { skipped++; continue; }
        commands.push(mk({ kind: 'alias', name, target: t.name, args: m.args || null, access: t.access, group: t.group, globalCooldown: t.globalCooldown, userCooldown: t.userCooldown, usageCount: t.usageCount, response: null, enabled: isOn(m.enabled ?? '') }));
        aliases++;
      }
      return json(200, { ok: true, mode: body.mode, commands: cmds, aliases, skipped });
    }
    if (p === '/api/commands' || p === '/api/commands/delete') return json(200, { ok: true });

    // ── Lists (mock CRUD) ──────────────────────────────────────────────────
    if (p === '/api/lists/create') {
      const name = String(body.name ?? '').toLowerCase().replace(/^!/, '').trim();
      if (name && !listByName(name)) {
        mockLists.push({ name, displayName: body.displayName ? String(body.displayName) : null, description: body.description ? String(body.description) : null,
          permission: Number(body.permission) || 3, createdByName: me.user.displayName, createdAt: iso(0), entries: [] });
      }
      return json(200, { ok: true });
    }
    if (p === '/api/lists/update') {
      const l = listByName(String(body.name ?? ''));
      if (l) {
        if ('displayName' in body) l.displayName = String(body.displayName ?? '') || null;
        if ('description' in body) l.description = String(body.description ?? '') || null;
        if ('permission' in body) l.permission = Number(body.permission) || 0;
        if (body.newName != null && String(body.newName).trim()) l.name = String(body.newName).toLowerCase().replace(/^!/, '').trim();
      }
      return json(200, { ok: true });
    }
    if (p === '/api/lists/delete') {
      const i = mockLists.findIndex((l) => l.name === String(body.name ?? '').toLowerCase().replace(/^!/, '').trim());
      if (i >= 0) mockLists.splice(i, 1);
      return json(200, { ok: true });
    }
    if (p === '/api/lists/entries/add') {
      const l = listByName(String(body.list ?? ''));
      if (l && String(body.text ?? '').trim()) l.entries.push(entry(String(body.text).trim(), me.user.displayName, 0));
      return json(200, { ok: true });
    }
    if (p === '/api/lists/entries/update') {
      const l = listByName(String(body.list ?? ''));
      const en = l && l.entries.find((x) => x.id === Number(body.id));
      if (en && String(body.text ?? '').trim()) en.text = String(body.text).trim();
      return json(200, { ok: true });
    }
    if (p === '/api/lists/entries/delete') {
      const l = listByName(String(body.list ?? ''));
      if (l) l.entries = l.entries.filter((x) => x.id !== Number(body.id));
      return json(200, { ok: true });
    }

    // ── Quotes (mock CRUD) ─────────────────────────────────────────────────
    if (p === '/api/quotes/update') {
      const q = mockQuotes.find((x) => x.id === Number(body.id));
      if (q) {
        if ('text' in body) q.text = String(body.text ?? '');
        if ('user' in body) q.user = String(body.user ?? '').replace(/^@/, '');
        if ('game' in body) q.game = String(body.game ?? '').trim() || null;
        if ('date' in body) { const parts = String(body.date ?? '').split(/[^0-9]+/).filter(Boolean); if (parts.length === 3) q.date = parts[0] + '-' + parts[1]!.padStart(2, '0') + '-' + parts[2]!.padStart(2, '0'); }
      }
      return json(200, { ok: true });
    }
    if (p === '/api/quotes/delete') {
      const i = mockQuotes.findIndex((x) => x.id === Number(body.id));
      if (i >= 0) mockQuotes.splice(i, 1);
      return json(200, { ok: true });
    }
    if (p === '/api/quotes/import') {
      const items = mapCsvRows(parseCsv(String(body.csv ?? '')), QUOTE_CSV_SPEC)
        .map((m) => ({ text: m.text ?? '', user: (m.user ?? '').replace(/^@/, ''), game: (m.game ?? '') || null, date: (m.date ?? '') || dISO(0), quotedByName: (m.quotedByName ?? '') || null }))
        .filter((x) => x.text && x.user);
      if (body.mode === 'replace') mockQuotes.length = 0;
      let nextId = mockQuotes.reduce((mx, q) => Math.max(mx, q.id), 0);
      for (const d of items) mockQuotes.unshift({ id: ++nextId, text: d.text, user: d.user, game: d.game, date: d.date, quotedByName: d.quotedByName, createdAt: new Date().toISOString() });
      mockQuotes.sort((a, b) => b.id - a.id);
      return json(200, { ok: true, mode: body.mode, added: items.length });
    }
    if (p === '/api/lists/import') {
      const mapped = mapCsvRows(parseCsv(String(body.csv ?? '')), LIST_CSV_SPEC);
      const toLevel = (s: string) => { const i = LVL.findIndex((l) => l.toLowerCase() === s.toLowerCase()); return i >= 0 ? i : 3; };
      const mode = String(body.mode ?? '');
      if (mode === 'replace-all') {
        mockLists.length = 0;
        const byName = new Map<string, MockList>();
        for (const m of mapped) {
          const name = (m.list ?? '').trim(); if (!name) continue;
          const key = name.toLowerCase();
          let g = byName.get(key);
          if (!g) { g = { name: key, displayName: (m.displayName ?? '') || null, description: (m.description ?? '') || null, permission: toLevel(m.permission ?? ''), createdByName: me.user.displayName, createdAt: iso(0), entries: [] }; byName.set(key, g); mockLists.push(g); }
          if ((m.text ?? '').trim()) g.entries.push(entry(m.text!, m.addedByName ?? '', 0));
        }
        return json(200, { ok: true, mode, lists: byName.size });
      }
      const l = listByName(String(body.list ?? ''));
      if (l) {
        const entries = mapped.filter((m) => (m.text ?? '').trim());
        if (mode === 'replace') l.entries.length = 0;
        for (const m of entries) l.entries.push(entry(m.text!, m.addedByName ?? '', 0));
        return json(200, { ok: true, mode, added: entries.length });
      }
      return json(200, { ok: true, mode, added: 0 });
    }

    res.writeHead(404); return res.end('Not Found');
  }
  res.writeHead(405); res.end('Method Not Allowed');
});

server.listen(PORT, () => {
  const who = loggedOut ? 'logged-out' : `logged-in as ${me.user.displayName} (${which})`;
  console.log(`Site preview (${who}) → http://localhost:${PORT}/`);
});
