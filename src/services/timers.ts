import type { Storage } from './storage/index.js';
import type { Logger } from './logger.js';

/** A user-facing timer error (bad name, duplicate, unknown timer, …). */
export class TimerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimerError';
  }
}

/** A stored timer definition. */
export interface TimerDef {
  name: string;
  periodSeconds: number;
  command: string;
  looping: boolean;
}

/** A timer with its live runtime state, for status/list/dashboard. */
export interface TimerView extends TimerDef {
  /** Whether a countdown is currently armed (one-shot or loop). */
  running: boolean;
  /** The armed mode, or null when idle. */
  mode: 'once' | 'loop' | null;
  /** Whole seconds until the next fire, or 0 when idle. */
  secondsLeft: number;
}

/** Runs the command a timer is bound to, as if the broadcaster invoked it. */
export type FireFn = (command: string) => void | Promise<void>;
/** Whether the channel is currently live (loop mode skips fires while offline). */
export type IsLiveFn = () => boolean | Promise<boolean>;

interface Runtime {
  mode: 'once' | 'loop';
  nextFireAt: number;
  handle: ReturnType<typeof setTimeout>;
}

/** Lowercase reference key for a timer name (case-insensitive lookups). */
export function timerKey(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * Named timers that fire a bound command once (after a delay) or on a loop
 * (every period). The definition + whether loop mode is armed persist; the
 * countdown to the next fire is in-memory, so `looping` timers resume on startup
 * (see `resumeLoops`) while a pending one-shot is dropped on restart.
 *
 * Firing is delegated to an injected `fire` callback (the plugin runs the bound
 * command as the broadcaster) and gated by an injected `isLive` in loop mode, so
 * this service stays free of chat/router/api coupling and is easy to test.
 */
export class TimerService {
  private readonly runtime = new Map<string, Runtime>();
  private fireFn: FireFn = () => {};
  private isLiveFn: IsLiveFn = () => true;
  private logger?: Logger;

  constructor(private readonly storage: Storage) {}

  private get db() {
    return this.storage.prisma;
  }

  /** Wire the execution + live-check callbacks (called once by the plugin). */
  configure(opts: { fire: FireFn; isLive: IsLiveFn; logger?: Logger }): void {
    this.fireFn = opts.fire;
    this.isLiveFn = opts.isLive;
    this.logger = opts.logger;
  }

  // ── Definitions (CRUD) ──────────────────────────────────────────────────────

  /** Create a timer. Throws if the name exists or inputs are invalid. */
  async add(name: string, periodSeconds: number, command: string): Promise<TimerDef> {
    const clean = this.validate(name, periodSeconds, command);
    const existing = await this.db.timer.findUnique({ where: { key: clean.key } });
    if (existing) throw new TimerError(`A timer named "${existing.name}" already exists.`);
    const row = await this.db.timer.create({
      data: { key: clean.key, name: clean.name, periodSeconds: clean.periodSeconds, command: clean.command },
    });
    return this.toDef(row);
  }

  /** Update a timer's period and command; reschedules if it is running. */
  async edit(name: string, periodSeconds: number, command: string): Promise<TimerDef> {
    const clean = this.validate(name, periodSeconds, command);
    const row = await this.db.timer.findUnique({ where: { key: clean.key } });
    if (!row) throw new TimerError(`No timer named "${name}".`);
    const updated = await this.db.timer.update({
      where: { key: clean.key },
      data: { periodSeconds: clean.periodSeconds, command: clean.command },
    });
    // Restart the countdown with the new settings, preserving the current mode.
    const rt = this.runtime.get(clean.key);
    if (updated.looping) this.schedule(clean.key, 'loop', updated.periodSeconds, updated.command);
    else if (rt?.mode === 'once') this.schedule(clean.key, 'once', updated.periodSeconds, updated.command);
    return this.toDef(updated);
  }

  /** Abort (if running) and delete a timer. Throws if it does not exist. */
  async delete(name: string): Promise<void> {
    const key = timerKey(name);
    const row = await this.db.timer.findUnique({ where: { key } });
    if (!row) throw new TimerError(`No timer named "${name}".`);
    this.cancel(key);
    await this.db.timer.delete({ where: { key } });
  }

  /** All timers with their live runtime state, sorted by name. */
  async list(): Promise<TimerView[]> {
    const rows = await this.db.timer.findMany({ orderBy: { name: 'asc' } });
    return rows.map((r) => this.toView(r));
  }

  /** A single timer with runtime state, or null if unknown. */
  async get(name: string): Promise<TimerView | null> {
    const row = await this.db.timer.findUnique({ where: { key: timerKey(name) } });
    return row ? this.toView(row) : null;
  }

  // ── Control ─────────────────────────────────────────────────────────────────

  /** Start a one-shot: fire once after the period. Clears loop mode. */
  async start(name: string): Promise<TimerDef> {
    const key = timerKey(name);
    const row = await this.db.timer.findUnique({ where: { key } });
    if (!row) throw new TimerError(`No timer named "${name}".`);
    const updated = row.looping ? await this.db.timer.update({ where: { key }, data: { looping: false } }) : row;
    this.schedule(key, 'once', updated.periodSeconds, updated.command);
    return this.toDef(updated);
  }

  /** Arm loop mode: fire every period (persisted, so it resumes after restart). */
  async loop(name: string): Promise<TimerDef> {
    const key = timerKey(name);
    const row = await this.db.timer.findUnique({ where: { key } });
    if (!row) throw new TimerError(`No timer named "${name}".`);
    const updated = row.looping ? row : await this.db.timer.update({ where: { key }, data: { looping: true } });
    this.schedule(key, 'loop', updated.periodSeconds, updated.command);
    return this.toDef(updated);
  }

  /** Disarm loop mode (if set) and abort the current countdown. */
  async stop(name: string): Promise<TimerDef> {
    const key = timerKey(name);
    const row = await this.db.timer.findUnique({ where: { key } });
    if (!row) throw new TimerError(`No timer named "${name}".`);
    this.cancel(key);
    const updated = row.looping ? await this.db.timer.update({ where: { key }, data: { looping: false } }) : row;
    return this.toDef(updated);
  }

  /** Whole seconds until the named timer next fires, or 0 if it is idle. */
  status(name: string): number {
    const rt = this.runtime.get(timerKey(name));
    if (!rt) return 0;
    return Math.max(0, Math.ceil((rt.nextFireAt - Date.now()) / 1000));
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  /** Schedule every timer that was left in loop mode (call once on startup). */
  async resumeLoops(): Promise<void> {
    const rows = await this.db.timer.findMany({ where: { looping: true } });
    for (const r of rows) this.schedule(r.key, 'loop', r.periodSeconds, r.command);
  }

  /** Cancel all in-memory countdowns (call on shutdown). */
  stopAllRuntime(): void {
    for (const key of [...this.runtime.keys()]) this.cancel(key);
  }

  // ── internals ───────────────────────────────────────────────────────────────

  private schedule(key: string, mode: 'once' | 'loop', periodSeconds: number, command: string): void {
    this.cancel(key);
    const periodMs = periodSeconds * 1000;
    const rt: Runtime = { mode, nextFireAt: Date.now() + periodMs, handle: undefined as unknown as Runtime['handle'] };

    const onFire = async () => {
      if (mode === 'loop') {
        // Reschedule up front so the period stays stable regardless of the fire.
        rt.nextFireAt = Date.now() + periodMs;
        rt.handle = setTimeout(() => void onFire(), periodMs);
      } else {
        this.runtime.delete(key);
      }
      try {
        // Loop mode is skipped while offline; a one-shot always fires.
        if (mode === 'once' || (await this.isLiveFn())) await this.fireFn(command);
      } catch (err) {
        this.logger?.warn({ err, key }, 'timers: fire failed');
      }
    };

    rt.handle = setTimeout(() => void onFire(), periodMs);
    this.runtime.set(key, rt);
  }

  private cancel(key: string): void {
    const rt = this.runtime.get(key);
    if (rt) clearTimeout(rt.handle);
    this.runtime.delete(key);
  }

  private validate(name: string, periodSeconds: number, command: string): {
    key: string;
    name: string;
    periodSeconds: number;
    command: string;
  } {
    const trimmed = name.trim();
    if (!trimmed) throw new TimerError('Provide a timer name.');
    if (/\s/.test(trimmed)) throw new TimerError('A timer name must be a single word.');
    const period = Math.floor(Number(periodSeconds));
    if (!Number.isFinite(period) || period < 1) throw new TimerError('The period must be a whole number of seconds (>= 1).');
    const cmd = command.trim();
    if (!cmd.startsWith('!')) throw new TimerError('The bound command must start with "!", e.g. !shoutout.');
    return { key: timerKey(trimmed), name: trimmed, periodSeconds: period, command: cmd };
  }

  private toDef(row: { name: string; periodSeconds: number; command: string; looping: boolean }): TimerDef {
    return { name: row.name, periodSeconds: row.periodSeconds, command: row.command, looping: row.looping };
  }

  private toView(row: { key: string; name: string; periodSeconds: number; command: string; looping: boolean }): TimerView {
    const rt = this.runtime.get(row.key);
    return {
      ...this.toDef(row),
      running: !!rt,
      mode: rt?.mode ?? null,
      secondsLeft: rt ? Math.max(0, Math.ceil((rt.nextFireAt - Date.now()) / 1000)) : 0,
    };
  }
}
