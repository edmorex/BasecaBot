/**
 * Crowd Hype activity tracking — pure logic, no I/O.
 *
 * The plugin feeds chat in and asks three questions: how worked up is chat right
 * now, who is doing the talking, and which row should each of them stand in.
 * Keeping all of that here means the row-shuffling and hysteresis rules can be
 * tested without a chat connection, a browser or a clock.
 */

/** One chat message as the crowd cares about it. */
export interface CrowdEntry {
  ts: number;
  userId: string;
  name: string;
  /** How many emote instances the message carried. */
  emotes: number;
}

/** A chatter and how loud they have been lately. */
export interface CrowdMember {
  userId: string;
  name: string;
  /** Messages + emotes inside the window; what the ranking sorts on. */
  score: number;
  /** When they last said anything, used to break ties toward the most recent. */
  lastAt: number;
}

/** Where a chatter is standing, and since when (the debounce clock). */
export interface RowSlot {
  row: number;
  since: number;
}

export interface RowOptions {
  rows: number;
  perRow: number;
  /** How long a chatter is pinned to their row before they may be moved. */
  debounceMs: number;
  now: number;
}

/** Excitement runs 1 (calm) to 5 (hype). */
export const MAX_LEVEL = 5;

/**
 * How many people a given row holds.
 *
 * Rows alternate full and one-short: the front row takes `perRow`, the one behind
 * it `perRow - 1`, then full again. The overlay sits the short rows at the
 * midpoints of the row in front, so the gaps between front-row heads are filled
 * rather than lining everyone up in columns.
 */
export function rowCapacity(row: number, perRow: number): number {
  const full = Math.max(2, Math.floor(perRow));
  return row % 2 === 1 ? full - 1 : full;
}

/**
 * A rolling window of chat activity.
 *
 * Two horizons, deliberately different:
 *
 *  - `entries` is the recent message buffer, pruned to the RATE window. It backs
 *    both the rate and the ranking score, so "most active" always means active
 *    just now.
 *  - `present` is one row per chatter, pruned to the much longer SURVIVAL
 *    horizon. It is what decides who is still on screen, so someone who posted
 *    once five minutes ago stays in the crowd without their old messages
 *    outranking a chatter who is talking right now.
 *
 * Keeping presence separate also means the message buffer stays short: it holds
 * seconds of chat rather than minutes, however long people linger.
 */
export class CrowdTracker {
  private entries: CrowdEntry[] = [];
  private present = new Map<string, { name: string; lastAt: number }>();

  add(e: CrowdEntry): void {
    this.entries.push(e);
    const seen = this.present.get(e.userId);
    if (seen) {
      seen.name = e.name;
      seen.lastAt = Math.max(seen.lastAt, e.ts);
    } else {
      this.present.set(e.userId, { name: e.name, lastAt: e.ts });
    }
  }

  /**
   * Age out both horizons. `survivalMs` defaults to the rate window, which is the
   * old behaviour of dropping a chatter as soon as their activity expires.
   */
  prune(now: number, windowMs: number, survivalMs = windowMs): void {
    const cutoff = now - windowMs;
    let i = 0;
    while (i < this.entries.length && this.entries[i]!.ts < cutoff) i++;
    if (i > 0) this.entries.splice(0, i);

    const gone = now - Math.max(windowMs, survivalMs);
    for (const [userId, seen] of this.present) {
      if (seen.lastAt < gone) this.present.delete(userId);
    }
  }

  /** Messages still in the rate buffer. */
  get size(): number {
    return this.entries.length;
  }

  /** Chatters currently counted as on screen. */
  get presentCount(): number {
    return this.present.size;
  }

  /** Messages + emotes per second over the window. */
  rate(now: number, windowMs: number): number {
    if (windowMs <= 0) return 0;
    const cutoff = now - windowMs;
    let units = 0;
    for (const e of this.entries) {
      if (e.ts < cutoff) continue;
      units += 1 + Math.max(0, e.emotes);
    }
    return units / (windowMs / 1000);
  }

  /**
   * Everyone still on screen, loudest first.
   *
   * The score counts only what is inside the rate window, so a chatter who has
   * gone quiet falls to zero and sorts below anyone still talking — but they stay
   * in the list until the survival horizon drops them. Ties go to whoever spoke
   * most recently, which orders the quiet tail newest-first.
   */
  ranking(now: number, windowMs: number): CrowdMember[] {
    const cutoff = now - windowMs;
    const scores = new Map<string, number>();
    for (const e of this.entries) {
      if (e.ts < cutoff) continue;
      scores.set(e.userId, (scores.get(e.userId) ?? 0) + 1 + Math.max(0, e.emotes));
    }
    const out: CrowdMember[] = [];
    for (const [userId, seen] of this.present) {
      out.push({ userId, name: seen.name, score: scores.get(userId) ?? 0, lastAt: seen.lastAt });
    }
    return out.sort((a, b) => b.score - a.score || b.lastAt - a.lastAt);
  }

  clear(): void {
    this.entries = [];
    this.present.clear();
  }
}

/**
 * Which excitement level a rate falls in. `thresholds` is ascending, one entry
 * per level; the first should be 0 so level 1 always matches.
 */
export function excitementLevel(rate: number, thresholds: readonly number[]): number {
  let level = 1;
  for (let i = 0; i < thresholds.length; i++) {
    if (rate >= thresholds[i]!) level = i + 1;
  }
  return Math.min(Math.max(1, level), Math.max(1, thresholds.length));
}

/**
 * Place the ranked chatters into rows, BACK row first.
 *
 * The farthest row is the prime spot: the loudest chatters fill it, and the rows
 * in front take the overflow (the odd-numbered rows one fewer, see rowCapacity).
 *
 * The catch is that chat rankings churn constantly, and reassigning strictly by
 * rank every tick would have people teleporting between rows several times a
 * second. So a chatter is pinned to their row for `debounceMs` after arriving in
 * it: pinned chatters are seated first and everyone else fills what is left,
 * which means a newly-loud chatter waits for a gap rather than shoving someone
 * aside mid-animation.
 */
export function assignRows(
  ranked: readonly CrowdMember[],
  prev: ReadonlyMap<string, RowSlot>,
  opts: RowOptions,
): Map<string, RowSlot> {
  const rows = Math.max(1, Math.floor(opts.rows));
  const perRow = Math.max(2, Math.floor(opts.perRow));
  const caps = Array.from({ length: rows }, (_, r) => rowCapacity(r, perRow));
  const capacity = caps.reduce((a, b) => a + b, 0);
  const onScreen = ranked.slice(0, capacity);
  const counts = new Array<number>(rows).fill(0);
  const out = new Map<string, RowSlot>();

  // Pass 1: anyone still inside their debounce keeps their row, if it has space.
  for (const m of onScreen) {
    const p = prev.get(m.userId);
    if (!p || p.row >= rows) continue;
    if (opts.now - p.since >= opts.debounceMs) continue;
    if (counts[p.row]! >= caps[p.row]!) continue;
    out.set(m.userId, { row: p.row, since: p.since });
    counts[p.row]!++;
  }

  // Pass 2: everyone else takes the backmost row with room, in rank order.
  for (const m of onScreen) {
    if (out.has(m.userId)) continue;
    let row = rows - 1;
    while (row >= 0 && counts[row]! >= caps[row]!) row--;
    if (row < 0) continue; // no seat left (only reachable if rows/perRow shrank)
    const p = prev.get(m.userId);
    // The clock only restarts on an actual move, or a chatter who keeps their row
    // would never become eligible to leave it.
    out.set(m.userId, { row, since: p && p.row === row ? p.since : opts.now });
    counts[row]!++;
  }

  return out;
}
