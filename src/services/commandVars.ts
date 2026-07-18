import { create, all } from 'mathjs';
import type { ApiClient } from '@twurple/api';
import type { Logger } from './logger.js';
import type { PointsService } from './points.js';
import type { UsersService } from './users.js';
import type { QuotesService } from './quotes.js';
import type { ListsService } from './lists.js';
import type { CustomCommandService } from './customCommands.js';
import { formatQuote } from './quotes.js';

/**
 * Custom-command variable engine — a StreamElements-style templating layer.
 *
 * Responses may embed variables written as `$(name args…)` or `${name args…}`
 * (interchangeable). Variables nest, and their arguments may be quoted or contain
 * other variables (evaluated depth-first). Unknown variables and missing values
 * resolve to an empty string, and any resolver error is swallowed (logged at
 * debug) so a bad template never breaks the command.
 *
 * Documented in docs/command-vars.md.
 */

/** Per-invocation context. */
export interface VarContext {
  sender: { id: string; login: string; displayName: string };
  channel: string;
  /** Whitespace-split arguments the user supplied. */
  args: string[];
  /** The full argument string (everything after the command word). */
  argString: string;
  /** The firing command, for $(count). */
  command?: { name: string; count: number };
}

/** Services the resolvers need. */
export interface VarDeps {
  points: PointsService;
  users: UsersService;
  quotes: QuotesService;
  lists: ListsService;
  customCommands: CustomCommandService;
  api: ApiClient;
  broadcasterUsername: string;
  pointsName: string;
  logger: Logger;
}

const MAX_DEPTH = 15;
const MAX_REPEAT = 20;

// ── math.js (locked down: expressions can't inject JS via import/createUnit) ────
const math = create(all!, {});
// Disable the two functions that let an expression define new functions/units
// (the code-injection vectors). We still call math.evaluate() ourselves.
math.import(
  { import: () => { throw new Error('disabled'); }, createUnit: () => { throw new Error('disabled'); } },
  { override: true },
);

// ── small helpers ──────────────────────────────────────────────────────────────

/** Strip a single pair of surrounding quotes, if present. */
function unquote(s: string): string {
  const t = s.trim();
  if (t.length >= 2 && (t[0] === '"' || t[0] === "'") && t[t.length - 1] === t[0]) return t.slice(1, -1);
  return t;
}

/** Quote-aware split: "…"/'…' become single tokens (quotes stripped). */
function splitArgs(s: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i]!)) i++;
    if (i >= s.length) break;
    let tok = '';
    const c = s[i]!;
    if (c === "'" || c === '"') {
      i++;
      while (i < s.length && s[i] !== c) tok += s[i++];
      i++; // closing quote
    } else {
      while (i < s.length && !/\s/.test(s[i]!)) tok += s[i++];
    }
    out.push(tok);
  }
  return out;
}

function sliceArgs(args: string[], from: number, to?: number): string {
  return args.slice(Math.max(0, from - 1), to).join(' ');
}

function humanDuration(ms: number): string {
  if (ms < 0) ms = 0;
  const totalMin = Math.floor(ms / 60000);
  const days = Math.floor(totalMin / 1440);
  const hours = Math.floor((totalMin % 1440) / 60);
  const mins = totalMin % 60;
  const parts: string[] = [];
  if (days) parts.push(`${days} day${days === 1 ? '' : 's'}`);
  if (hours) parts.push(`${hours} hour${hours === 1 ? '' : 's'}`);
  parts.push(`${mins} minute${mins === 1 ? '' : 's'}`);
  return parts.join(' ');
}

/** Parse a $(time.until) target: full ISO, or bare HH:MM (next occurrence, UTC). */
function parseUntil(input: string): Date | null {
  const s = input.trim();
  const hm = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (hm) {
    const now = new Date();
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), Number(hm[1]), Number(hm[2]), 0));
    if (d.getTime() <= now.getTime()) d.setUTCDate(d.getUTCDate() + 1); // next occurrence
    return d;
  }
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : new Date(t);
}

// ── cached Helix live-data ───────────────────────────────────────────────────────

interface Cached<T> { value: T; at: number }

/** Fetches + short-caches the Helix reads the channel.* / game / uptime / emote / chatter variables need. */
class LiveData {
  private bid: string | null | undefined; // undefined = not yet resolved
  private streamC?: Cached<{ viewers: number; startDate: Date } | null>;
  private infoC?: Cached<{ gameName: string; title: string; displayName: string } | null>;
  private followersC?: Cached<number>;
  private emotesC?: Cached<string[]>;
  private chattersC?: Cached<string[]>;
  private readonly byName = new Map<string, Cached<{ gameName: string; title: string; startDate: Date | null } | null>>();

  constructor(
    private readonly api: ApiClient,
    private readonly broadcasterUsername: string,
    private readonly logger: Logger,
  ) {}

  private fresh<T>(c: Cached<T> | undefined, ttl: number): c is Cached<T> {
    return !!c && Date.now() - c.at < ttl;
  }

  private async broadcasterId(): Promise<string | null> {
    if (this.bid !== undefined) return this.bid;
    try {
      const u = await this.api.users.getUserByName(this.broadcasterUsername);
      this.bid = u?.id ?? null;
    } catch (err) {
      this.logger.debug({ err }, 'commandVars: broadcaster lookup failed');
      this.bid = null;
    }
    return this.bid;
  }

  async stream(): Promise<{ viewers: number; startDate: Date } | null> {
    if (this.fresh(this.streamC, 15_000)) return this.streamC.value;
    const bid = await this.broadcasterId();
    let value: { viewers: number; startDate: Date } | null = null;
    if (bid) {
      const s = await this.api.streams.getStreamByUserId(bid);
      value = s ? { viewers: s.viewers, startDate: s.startDate } : null;
    }
    this.streamC = { value, at: Date.now() };
    return value;
  }

  async info(): Promise<{ gameName: string; title: string; displayName: string } | null> {
    if (this.fresh(this.infoC, 15_000)) return this.infoC.value;
    const bid = await this.broadcasterId();
    let value: { gameName: string; title: string; displayName: string } | null = null;
    if (bid) {
      const c = await this.api.channels.getChannelInfoById(bid);
      value = c ? { gameName: c.gameName, title: c.title, displayName: c.displayName } : null;
    }
    this.infoC = { value, at: Date.now() };
    return value;
  }

  async followerCount(): Promise<number> {
    if (this.fresh(this.followersC, 60_000)) return this.followersC.value;
    const bid = await this.broadcasterId();
    let value = 0;
    if (bid) value = (await this.api.channels.getChannelFollowers(bid)).total;
    this.followersC = { value, at: Date.now() };
    return value;
  }

  async uptime(): Promise<string | null> {
    const s = await this.stream();
    return s ? humanDuration(Date.now() - s.startDate.getTime()) : null;
  }

  private async emotes(): Promise<string[]> {
    if (this.fresh(this.emotesC, 300_000)) return this.emotesC.value;
    const bid = await this.broadcasterId();
    let value: string[] = [];
    if (bid) value = (await this.api.chat.getChannelEmotes(bid)).map((e) => e.name);
    this.emotesC = { value, at: Date.now() };
    return value;
  }

  async isEmote(code: string): Promise<boolean> {
    if (!code) return false;
    return (await this.emotes()).includes(code);
  }

  async randomEmote(): Promise<string> {
    const list = await this.emotes();
    return list.length ? list[Math.floor(Math.random() * list.length)]! : '';
  }

  async randomChatter(): Promise<string> {
    if (!this.fresh(this.chattersC, 15_000)) {
      const bid = await this.broadcasterId();
      let value: string[] = [];
      if (bid) value = (await this.api.chat.getChattersPaginated(bid).getAll()).map((c) => c.userDisplayName);
      this.chattersC = { value, at: Date.now() };
    }
    const list = this.chattersC!.value;
    return list.length ? list[Math.floor(Math.random() * list.length)]! : '';
  }

  /** Channel info (+ live start) for an ARBITRARY channel, for $(game/title/uptime username). */
  async infoOf(username: string): Promise<{ gameName: string; title: string; startDate: Date | null } | null> {
    const key = username.replace(/^@/, '').toLowerCase();
    const c = this.byName.get(key);
    if (this.fresh(c, 15_000)) return c.value;
    let value: { gameName: string; title: string; startDate: Date | null } | null = null;
    try {
      const u = await this.api.users.getUserByName(key);
      if (u) {
        const [ci, stream] = await Promise.all([this.api.channels.getChannelInfoById(u.id), this.api.streams.getStreamByUserId(u.id)]);
        if (ci) value = { gameName: ci.gameName, title: ci.title, startDate: stream?.startDate ?? null };
      }
    } catch (err) {
      this.logger.debug({ err, username: key }, 'commandVars: infoOf failed');
    }
    this.byName.set(key, { value, at: Date.now() });
    return value;
  }
}

// ── resolvers ────────────────────────────────────────────────────────────────

interface ResolverArgs {
  base: string;
  subs: string[];
  rest: string;
  tokens: string[];
  ctx: VarContext;
  deps: VarDeps;
  live: LiveData;
}

type Resolver = (a: ResolverArgs) => string | Promise<string>;

/**
 * Resolve a user token to id/login/display, falling back to the sender when no
 * token is given. The token may be any of the user's names (@handle, display
 * name, or alias); an unrecognized one echoes back as-is with no id, so a
 * command like `$(user.points X)` degrades to 0 rather than erroring.
 */
async function resolveUser(token: string | undefined, a: ResolverArgs) {
  const { ctx, deps } = a;
  if (!token) return { id: ctx.sender.id as string | null, login: ctx.sender.login, display: ctx.sender.displayName };
  const ref = await deps.users.resolveUserRef(token);
  if (ref.kind === 'user') return { id: ref.id as string | null, login: ref.login, display: ref.displayName };
  const bare = token.replace(/^@/, '');
  return { id: null, login: bare.toLowerCase(), display: bare };
}

const RESOLVERS: Record<string, Resolver> = {
  args: ({ subs, ctx }) => (subs[0] && /^\d+$/.test(subs[0]) ? (ctx.args[Number(subs[0]) - 1] ?? '') : ctx.argString),

  sender: senderResolver,
  source: senderResolver,

  user: async (a) => {
    const t = await resolveUser(a.tokens[0], a);
    if (a.subs[0] === 'name') return t.login;
    if (a.subs[0] === 'points') return t.id ? String(await a.deps.points.getBalance(t.id)) : '0';
    return t.display;
  },

  channel: async ({ subs, ctx, deps, live }) => {
    switch (subs[0]) {
      case 'display_name':
        return (await live.info())?.displayName ?? deps.broadcasterUsername;
      case 'viewers': {
        const s = await live.stream();
        return s ? String(s.viewers) : 'not live';
      }
      case 'followers':
        return String(await live.followerCount());
      case 'title':
        return (await live.info())?.title ?? '';
      case 'game': {
        const g = (await live.info())?.gameName;
        return g && g.trim() ? g : 'no game';
      }
      case 'uptime':
        return (await live.uptime()) ?? 'not live';
      default:
        return ctx.channel;
    }
  },

  count: async ({ tokens, ctx, deps }) => {
    const target = tokens[0];
    if (target) {
      const c = await deps.customCommands.getUsageCount({ kind: 'trigger', name: target.replace(/^!/, '') });
      return String(c ?? 0);
    }
    return String(ctx.command?.count ?? 0);
  },
  getcount: (a) => RESOLVERS.count!(a),

  game: async ({ tokens, live }) => {
    const g = tokens[0] ? (await live.infoOf(tokens[0]))?.gameName : (await live.info())?.gameName;
    return g && g.trim() ? g : '';
  },
  title: async ({ tokens, live }) => (tokens[0] ? (await live.infoOf(tokens[0]))?.title : (await live.info())?.title) ?? '',
  uptime: async ({ tokens, live }) => {
    if (!tokens[0]) return (await live.uptime()) ?? 'not live';
    const info = await live.infoOf(tokens[0]);
    return info?.startDate ? humanDuration(Date.now() - info.startDate.getTime()) : 'not live';
  },

  math: ({ rest }) => {
    const expr = unquote(rest);
    if (!expr) return '';
    const result = math.evaluate(expr) as unknown;
    return typeof result === 'number' || typeof result === 'string' || typeof result === 'boolean' ? String(result) : '';
  },

  pathescape: ({ rest }) => encodeURIComponent(unquote(rest)),
  queryescape: ({ rest }) => encodeURIComponent(unquote(rest)).replace(/%20/g, '+'),

  pointsname: ({ deps }) => deps.pointsName,

  quote: async ({ tokens, deps }) => {
    const idTok = tokens[0];
    const q = idTok && /^\d+$/.test(idTok) ? await deps.quotes.getById(Number(idTok)) : await deps.quotes.random();
    return q ? formatQuote(q) : '';
  },

  random: async ({ subs, rest, tokens, live }) => {
    switch (subs[0]) {
      case 'emote':
        return live.randomEmote();
      case 'chatter':
        return live.randomChatter();
      case 'pick':
        return tokens.length ? tokens[Math.floor(Math.random() * tokens.length)]! : '';
      default: {
        // $(random X-Y) or $(random.number X-Y), inclusive.
        const m = /^(-?\d+)\s*-\s*(-?\d+)$/.exec(rest.trim());
        if (!m) return '';
        let lo = Number(m[1]);
        let hi = Number(m[2]);
        if (lo > hi) [lo, hi] = [hi, lo];
        return String(Math.floor(Math.random() * (hi - lo + 1)) + lo);
      }
    }
  },

  repeat: ({ tokens, rest }) => {
    const n = Number.parseInt(tokens[0] ?? '', 10);
    if (!Number.isFinite(n) || n <= 0) return '';
    const phrase = unquote(rest.slice((tokens[0] ?? '').length).trim());
    return Array(Math.min(n, MAX_REPEAT)).fill(phrase).join(' ');
  },

  list: async ({ subs, tokens, deps }) => {
    const ref = tokens[0];
    if (!ref) return '';
    if (subs[0] === undefined) return (await deps.lists.displayNameOf(ref)) ?? '';
    if (subs[0] === '0') return (await deps.lists.random(ref)) ?? '';
    if (/^\d+$/.test(subs[0])) return (await deps.lists.entryAt(ref, Number(subs[0]))) ?? '';
    return '';
  },

  time: ({ subs, tokens, rest }) => {
    if (subs[0] === 'until') {
      const target = parseUntil(rest.trim());
      return target ? humanDuration(target.getTime() - Date.now()) : '';
    }
    const tz = subs[0] === 'timezone' ? tokens[0] || 'UTC' : subs[0] === 'utc' || !subs[0] ? 'UTC' : subs[0];
    try {
      return new Date().toLocaleTimeString('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' });
    } catch {
      return '';
    }
  },
};

function senderResolver({ subs, ctx, deps }: ResolverArgs): string | Promise<string> {
  if (subs[0] === 'name') return ctx.sender.login;
  if (subs[0] === 'points') return deps.points.getBalance(ctx.sender.id).then(String);
  return ctx.sender.displayName;
}

/** $(1), $(2.emote), $(3.word) — a numeric argument index with an optional filter. */
async function argIndexResolver(a: ResolverArgs): Promise<string> {
  const val = a.ctx.args[Number(a.base) - 1] ?? '';
  if (a.subs[0] === 'emote') return (await a.live.isEmote(val)) ? val : '';
  if (a.subs[0] === 'word') return /^[\p{L}\p{N}]+$/u.test(val) ? val : '';
  return val;
}

// ── parser / evaluator ───────────────────────────────────────────────────────

/** Read a balanced `$(`/`${` body starting at `start` (just past the opener). */
function readBalanced(s: string, start: number, close: string): { inner: string; end: number } {
  const stack = [close];
  let i = start;
  let quote: string | null = null;
  while (i < s.length) {
    const c = s[i]!;
    if (quote) {
      if (c === quote) quote = null;
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      i++;
      continue;
    }
    if (c === '$' && (s[i + 1] === '(' || s[i + 1] === '{')) {
      stack.push(s[i + 1] === '(' ? ')' : '}');
      i += 2;
      continue;
    }
    if (c === stack[stack.length - 1]) {
      stack.pop();
      if (stack.length === 0) return { inner: s.slice(start, i), end: i + 1 };
      i++;
      continue;
    }
    i++;
  }
  return { inner: '', end: -1 }; // unbalanced
}

export class CommandVarEngine {
  private readonly live: LiveData;

  constructor(private readonly deps: VarDeps) {
    this.live = new LiveData(deps.api, deps.broadcasterUsername, deps.logger);
  }

  /** Expand a template. Never throws — resolver errors degrade to empty strings. */
  async render(template: string, ctx: VarContext): Promise<string> {
    return this.evaluate(template, ctx, 0);
  }

  private async evaluate(s: string, ctx: VarContext, depth: number): Promise<string> {
    if (depth > MAX_DEPTH) return '';
    let out = '';
    let i = 0;
    while (i < s.length) {
      if (s[i] === '$' && (s[i + 1] === '(' || s[i + 1] === '{')) {
        const close = s[i + 1] === '(' ? ')' : '}';
        const { inner, end } = readBalanced(s, i + 2, close);
        if (end === -1) {
          out += s[i];
          i++;
          continue;
        }
        out += await this.evalVar(inner, ctx, depth);
        i = end;
      } else {
        out += s[i];
        i++;
      }
    }
    return out;
  }

  private async evalVar(inner: string, ctx: VarContext, depth: number): Promise<string> {
    // Resolve nested variables first (depth-first), then parse name + args.
    const resolved = (await this.evaluate(inner, ctx, depth + 1)).trim();
    if (!resolved) return '';
    const m = /^(\S+)(?:\s+([\s\S]*))?$/.exec(resolved);
    if (!m) return '';
    const firstToken = m[1]!;
    const rest = (m[2] ?? '').trim();

    // ${n:} / ${n:m} — argument slice.
    const colon = /^(\d+):(\d*)$/.exec(firstToken);
    if (colon) return sliceArgs(ctx.args, Number(colon[1]), colon[2] ? Number(colon[2]) : undefined);

    const segs = firstToken.split('.');
    const base = segs[0]!.toLowerCase();
    const subs = segs.slice(1).map((x) => x.toLowerCase());
    const tokens = splitArgs(rest);
    const a: ResolverArgs = { base, subs, rest, tokens, ctx, deps: this.deps, live: this.live };

    const resolver = RESOLVERS[base] ?? (/^\d+$/.test(base) ? argIndexResolver : undefined);
    if (!resolver) return ''; // unknown variable -> empty
    try {
      return String((await resolver(a)) ?? '');
    } catch (err) {
      this.deps.logger.debug({ err, base }, 'commandVars: resolver error');
      return '';
    }
  }
}
