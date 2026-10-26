import { randomBytes } from 'node:crypto';
import type { Storage } from './storage/index.js';
import type { Logger } from './logger.js';

/**
 * The control-token API: a second credential for surfaces that cannot hold a
 * browser login — a Stream Deck button, a shell script, a phone shortcut.
 *
 * Both the switch and the token live in the database rather than the environment
 * so the broadcaster can rotate or kill access from the dashboard mid-stream,
 * without shell access and without a restart. The master switch is checked
 * independently of the token: turning it off refuses a *valid* token, which is
 * what makes it useful as a panic button.
 */

/** One endpoint the control token may reach. */
export interface ControlEndpoint {
  /** Path as routed, without the host. */
  path: string;
  /** Short label for the panel. */
  label: string;
  /** What it does, in a sentence. */
  summary: string;
  /** An example JSON body, or null when the endpoint takes none. */
  example: string | null;
}

/**
 * THE list of what a control token can reach, and the single source of truth for
 * it: the admin panel renders this, and the docs quote it.
 *
 * It does NOT grant anything. Each handler opts in by calling
 * `requireAdminOrControl` instead of `requireAdmin`, so adding a line here cannot
 * widen access on its own — and a test asserts this list and those handlers match
 * exactly, so the panel can never quietly under-report what a token can do.
 */
export const CONTROL_ENDPOINTS: readonly ControlEndpoint[] = freezeAll([
  {
    path: '/api/admin/crowd/live',
    label: 'Crowd Hype — live control',
    summary: 'Excitement ceiling, slow mode, clear, quiesce, resume and the chat simulation.',
    example: '{"action":"max-level","level":4}',
  },
  {
    path: '/api/admin/boss/start',
    label: 'Boss Battle — start',
    summary: 'Begin a real battle. A null bossId picks one at random.',
    example: '{"bossId":null,"delaySeconds":15}',
  },
  {
    path: '/api/admin/boss/cancel',
    label: 'Boss Battle — cancel',
    summary: 'Call off the battle in progress.',
    example: null,
  },
  {
    path: '/api/admin/boss/sim/spawn',
    label: 'Boss Battle — mock spawn',
    summary: 'Full presentation, nothing recorded and no achievements.',
    example: '{"bossId":null}',
  },
  {
    path: '/api/admin/boss/sim/action',
    label: 'Boss Battle — mock action',
    summary: 'Stand in for a chatter hitting, missing, healing or sending a duplicate.',
    example: '{"action":"hit"}',
  },
  {
    path: '/api/admin/floof/fire',
    label: 'Pet the Floof — spawn',
    summary: 'Send a floof across the screen. Nulls mean a random photo and style.',
    example: '{"image":null,"style":null}',
  },
  {
    path: '/api/admin/floof/simulate-pet',
    label: 'Pet the Floof — simulate !pet',
    summary: 'Pet the active floof without writing a win to the database.',
    example: null,
  },
]);

/**
 * Frozen for real, not just `readonly`: the list is handed to the route layer and
 * serialised to the panel, so a stray push would change what every admin is told
 * their token can reach. `readonly` is erased at compile time and stops nothing.
 */
function freezeAll(list: ControlEndpoint[]): readonly ControlEndpoint[] {
  for (const e of list) Object.freeze(e);
  return Object.freeze(list);
}

/** What the admin panel is told. The token is sent separately and on request. */
export interface ApiControlState {
  enabled: boolean;
  /** Whether a token has been set at all. */
  configured: boolean;
  /** Last four characters, for recognising which token is in place. */
  hint: string;
  /** When the token was last changed, ISO 8601, or null if never. */
  updatedAt: string | null;
}

const KEY = 'apiControl';
const MIN_TOKEN = 16;
const MAX_TOKEN = 200;

/** A user-facing problem; safe to show in the panel. */
export class ApiControlError extends Error {}

interface Stored {
  enabled: boolean;
  token: string;
  updatedAt: string | null;
}

const EMPTY: Stored = { enabled: false, token: '', updatedAt: null };

export class ApiControlService {
  private state: Stored = { ...EMPTY };

  constructor(
    private readonly storage: Storage,
    private readonly logger: Logger,
  ) {}

  private get db() {
    return this.storage.prisma;
  }

  async init(): Promise<void> {
    try {
      const row = await this.db.setting.findUnique({ where: { key: KEY } });
      if (row) this.state = normalize(row.value);
    } catch (err) {
      // Fail closed: a database we cannot read leaves the API off, rather than
      // falling back to some default that might accept a token.
      this.logger.warn({ err }, 'apiControl: could not load settings');
      this.state = { ...EMPTY };
    }
  }

  /** The panel's view: never includes the token itself. */
  getState(): ApiControlState {
    return {
      enabled: this.state.enabled,
      configured: !!this.state.token,
      hint: this.state.token ? this.state.token.slice(-4) : '',
      updatedAt: this.state.updatedAt,
    };
  }

  /**
   * Whether `provided` may act right now. The switch is deliberately checked
   * first and separately, so that turning the API off refuses a token that is
   * otherwise perfectly valid.
   */
  get enabled(): boolean {
    return this.state.enabled;
  }

  get token(): string {
    return this.state.token;
  }

  async setEnabled(on: boolean): Promise<ApiControlState> {
    this.state.enabled = !!on;
    await this.save();
    this.logger.info({ enabled: this.state.enabled }, 'apiControl: switch toggled');
    return this.getState();
  }

  /**
   * Replace the token. A short one is refused rather than padded: this grants
   * write access, and a four-character token would be guessable in minutes.
   */
  async setToken(raw: string): Promise<ApiControlState> {
    const token = String(raw ?? '').trim();
    if (!token) throw new ApiControlError('Enter a token, or press Generate.');
    if (/\s/.test(token)) throw new ApiControlError('A token cannot contain spaces — it travels in an HTTP header.');
    if (token.length < MIN_TOKEN) throw new ApiControlError(`Use at least ${MIN_TOKEN} characters; this grants write access.`);
    if (token.length > MAX_TOKEN) throw new ApiControlError(`Keep it under ${MAX_TOKEN} characters.`);
    this.state.token = token;
    this.state.updatedAt = new Date().toISOString();
    await this.save();
    this.logger.info({ hint: token.slice(-4) }, 'apiControl: token changed');
    return this.getState();
  }

  /** Mint a token for the broadcaster, so nobody has to invent entropy by hand. */
  async generateToken(): Promise<string> {
    const token = randomBytes(24).toString('hex');
    await this.setToken(token);
    return token;
  }

  /** Forget the token, which also closes the API however the switch is set. */
  async clearToken(): Promise<ApiControlState> {
    this.state.token = '';
    this.state.updatedAt = null;
    await this.save();
    this.logger.info('apiControl: token cleared');
    return this.getState();
  }

  private async save(): Promise<void> {
    const value = JSON.stringify(this.state);
    await this.db.setting.upsert({
      where: { key: KEY },
      create: { key: KEY, value },
      update: { value },
    });
  }
}

/** Read a stored blob defensively — a hand-edited row must not crash startup. */
function normalize(value: string): Stored {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return { ...EMPTY };
  }
  if (!parsed || typeof parsed !== 'object') return { ...EMPTY };
  const o = parsed as Record<string, unknown>;
  const token = typeof o.token === 'string' ? o.token.trim() : '';
  return {
    enabled: o.enabled === true,
    token: token.length >= MIN_TOKEN && token.length <= MAX_TOKEN && !/\s/.test(token) ? token : '',
    updatedAt: typeof o.updatedAt === 'string' ? o.updatedAt : null,
  };
}
