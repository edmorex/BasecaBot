import { describe, it, expect } from 'vitest';
import { CrowdTracker, excitementLevel, assignRows, rowCapacity, type CrowdMember, type RowSlot } from './crowd.js';

const T0 = 1_000_000;
const member = (userId: string, score: number, lastAt = T0): CrowdMember => ({ userId, name: userId.toUpperCase(), score, lastAt });

describe('CrowdTracker', () => {
  it('counts messages and emotes together as one rate', () => {
    const t = new CrowdTracker();
    // 2 messages carrying 3 emotes between them = 5 units over 5s = 1/s.
    t.add({ ts: T0, userId: 'a', name: 'A', emotes: 2 });
    t.add({ ts: T0 + 1000, userId: 'b', name: 'B', emotes: 1 });
    expect(t.rate(T0 + 5000, 5000)).toBeCloseTo(1, 5);
  });

  it('ignores anything older than the window', () => {
    const t = new CrowdTracker();
    t.add({ ts: T0, userId: 'a', name: 'A', emotes: 0 });
    t.add({ ts: T0 + 9000, userId: 'b', name: 'B', emotes: 0 });
    expect(t.rate(T0 + 10_000, 5000)).toBeCloseTo(0.2, 5); // only B counts
  });

  it('reports a flat zero for silence', () => {
    expect(new CrowdTracker().rate(T0, 5000)).toBe(0);
  });

  it('ranks chatters loudest first', () => {
    const t = new CrowdTracker();
    t.add({ ts: T0, userId: 'quiet', name: 'Quiet', emotes: 0 });
    t.add({ ts: T0, userId: 'loud', name: 'Loud', emotes: 9 });
    t.add({ ts: T0, userId: 'mid', name: 'Mid', emotes: 2 });
    expect(t.ranking(T0 + 1000, 5000).map((m) => m.userId)).toEqual(['loud', 'mid', 'quiet']);
  });

  it('breaks ties toward whoever spoke most recently', () => {
    const t = new CrowdTracker();
    t.add({ ts: T0, userId: 'stale', name: 'Stale', emotes: 0 });
    t.add({ ts: T0 + 2000, userId: 'fresh', name: 'Fresh', emotes: 0 });
    expect(t.ranking(T0 + 3000, 5000).map((m) => m.userId)).toEqual(['fresh', 'stale']);
  });

  it('keeps the freshest display name for a chatter', () => {
    const t = new CrowdTracker();
    t.add({ ts: T0, userId: 'a', name: 'OldName', emotes: 0 });
    t.add({ ts: T0 + 100, userId: 'a', name: 'NewName', emotes: 0 });
    expect(t.ranking(T0 + 200, 5000)[0]!.name).toBe('NewName');
  });

  it('prunes aged entries so the buffer cannot grow without end', () => {
    const t = new CrowdTracker();
    for (let i = 0; i < 500; i++) t.add({ ts: T0 + i * 100, userId: 'a', name: 'A', emotes: 0 });
    expect(t.size).toBe(500);
    t.prune(T0 + 50_000, 5000);
    expect(t.size).toBeLessThan(60);
    // Pruning must not disturb the rate over the surviving window.
    expect(t.rate(T0 + 50_000, 5000)).toBeGreaterThan(0);
  });

  it('treats a negative emote count as zero rather than eating the message', () => {
    const t = new CrowdTracker();
    t.add({ ts: T0, userId: 'a', name: 'A', emotes: -5 });
    expect(t.rate(T0, 1000)).toBe(1);
  });
});

describe('excitementLevel', () => {
  const thresholds = [0, 1, 3, 6, 10];

  it('runs calm to hype as chat speeds up', () => {
    expect(excitementLevel(0, thresholds)).toBe(1);
    expect(excitementLevel(0.9, thresholds)).toBe(1);
    expect(excitementLevel(1, thresholds)).toBe(2);
    expect(excitementLevel(2.9, thresholds)).toBe(2);
    expect(excitementLevel(3, thresholds)).toBe(3);
    expect(excitementLevel(6, thresholds)).toBe(4);
    expect(excitementLevel(10, thresholds)).toBe(5);
  });

  it('pins at the top level however fast chat gets', () => {
    expect(excitementLevel(9999, thresholds)).toBe(5);
  });

  it('never drops below level 1', () => {
    expect(excitementLevel(-1, thresholds)).toBe(1);
    expect(excitementLevel(0, [])).toBe(1);
  });
});

describe('rowCapacity', () => {
  it('alternates full and one-short going back', () => {
    // The short rows sit on the midpoints of the row in front, filling the gaps
    // between heads instead of lining everyone up in columns.
    expect([0, 1, 2, 3].map((r) => rowCapacity(r, 6))).toEqual([6, 5, 6, 5]);
  });

  it('never drops below the two-per-row floor', () => {
    expect([0, 1].map((r) => rowCapacity(r, 2))).toEqual([2, 1]);
    expect(rowCapacity(0, 1)).toBe(2); // clamped up
    expect(rowCapacity(0, 0)).toBe(2);
  });
});

describe('assignRows', () => {
  // rows 3, perRow 2 -> capacities [2, 1, 2], five seats in total.
  const OPTS = { rows: 3, perRow: 2, debounceMs: 2000, now: T0 };
  const none = new Map<string, RowSlot>();

  it('seats the loudest in the front row and overflows backwards', () => {
    const ranked = ['a', 'b', 'c', 'd', 'e', 'f'].map((u, i) => member(u, 100 - i));
    const out = assignRows(ranked, none, OPTS);
    expect(out.get('a')!.row).toBe(0);
    expect(out.get('b')!.row).toBe(0);
    expect(out.get('c')!.row).toBe(1); // the short row takes one
    expect(out.get('d')!.row).toBe(2);
    expect(out.get('e')!.row).toBe(2);
    expect(out.has('f')).toBe(false);  // past capacity
  });

  it('never seats more than a row can hold', () => {
    const ranked = Array.from({ length: 20 }, (_, i) => member('u' + i, 100 - i));
    const out = assignRows(ranked, none, OPTS);
    const counts = [0, 0, 0];
    for (const slot of out.values()) counts[slot.row]!++;
    expect(counts).toEqual([2, 1, 2]);
  });

  it('fills a six-wide crowd 6/5/6 as documented', () => {
    const ranked = Array.from({ length: 40 }, (_, i) => member('u' + i, 100 - i));
    const out = assignRows(ranked, none, { rows: 3, perRow: 6, debounceMs: 0, now: T0 });
    const counts = [0, 0, 0];
    for (const slot of out.values()) counts[slot.row]!++;
    expect(counts).toEqual([6, 5, 6]);
    expect(out.size).toBe(17);
  });

  it('leaves chatters past capacity off screen entirely', () => {
    const ranked = Array.from({ length: 20 }, (_, i) => member('u' + i, 100 - i));
    const out = assignRows(ranked, none, OPTS);
    expect(out.size).toBe(5);
    expect(out.has('u19')).toBe(false);
  });

  it('pins a chatter to their row while the debounce is running', () => {
    // b was in the front row a moment ago; a surge of new chatters should not
    // yank them backwards mid-animation.
    const prev = new Map<string, RowSlot>([['b', { row: 0, since: T0 - 500 }]]);
    const ranked = [member('x', 99), member('y', 98), member('b', 1)];
    const out = assignRows(ranked, prev, OPTS);
    expect(out.get('b')!.row).toBe(0);
    // ...and the louder pair take the seats that are left.
    expect(out.get('x')!.row).toBe(0);
    expect(out.get('y')!.row).toBe(1);
  });

  it('lets them move once the debounce has expired', () => {
    const prev = new Map<string, RowSlot>([['b', { row: 0, since: T0 - 5000 }]]);
    const ranked = [member('x', 99), member('y', 98), member('b', 1)];
    const out = assignRows(ranked, prev, OPTS);
    expect(out.get('x')!.row).toBe(0);
    expect(out.get('y')!.row).toBe(0);
    expect(out.get('b')!.row).toBe(1);
  });

  it('does not restart the clock for a chatter who keeps their row', () => {
    // Otherwise a chatter re-seated in the same row every tick would never become
    // eligible to move, and the debounce would pin them forever.
    const prev = new Map<string, RowSlot>([['a', { row: 0, since: T0 - 1900 }]]);
    let out = assignRows([member('a', 10)], prev, OPTS);
    expect(out.get('a')!.since).toBe(T0 - 1900);
    out = assignRows([member('a', 10)], out, { ...OPTS, now: T0 + 200 });
    expect(out.get('a')!.since).toBe(T0 - 1900); // still the original arrival
  });

  it('stamps a fresh clock on an actual move', () => {
    const prev = new Map<string, RowSlot>([['a', { row: 2, since: T0 - 9000 }]]);
    const out = assignRows([member('a', 10)], prev, OPTS);
    expect(out.get('a')).toEqual({ row: 0, since: T0 });
  });

  it('forgets a chatter who has gone quiet', () => {
    const prev = new Map<string, RowSlot>([['gone', { row: 0, since: T0 }]]);
    expect(assignRows([member('a', 1)], prev, OPTS).has('gone')).toBe(false);
  });

  it('re-seats everyone when the row count shrinks under them', () => {
    const prev = new Map<string, RowSlot>([
      ['a', { row: 0, since: T0 }],
      ['b', { row: 2, since: T0 }],   // row 2 no longer exists
    ]);
    const out = assignRows([member('a', 9), member('b', 8)], prev, { ...OPTS, rows: 1, perRow: 2 });
    expect([...out.values()].every((s) => s.row === 0)).toBe(true);
  });

  it('copes with the smallest possible crowd', () => {
    // perRow floors at 2, so one row is two seats however small the setting.
    const out = assignRows([member('a', 9), member('b', 8), member('c', 7)], none, { ...OPTS, rows: 1, perRow: 1 });
    expect(out.size).toBe(2);
    expect(out.get('a')).toEqual({ row: 0, since: T0 });
    expect(out.has('c')).toBe(false);
  });

  it('settles rather than oscillating when two chatters swap rank each tick', () => {
    // The symptom the debounce exists to prevent: with one seat in the front row
    // and two chatters trading places, rows must not flip on every tick.
    const opts = { rows: 2, perRow: 1, debounceMs: 2000, now: T0 };
    let slots = new Map<string, RowSlot>();
    const moves: number[] = [];
    for (let tick = 0; tick < 20; tick++) {
      const now = T0 + tick * 200; // a tick every 200ms
      const ranked = tick % 2 === 0 ? [member('a', 10), member('b', 9)] : [member('b', 10), member('a', 9)];
      const next = assignRows(ranked, slots, { ...opts, now });
      let moved = 0;
      for (const [id, slot] of next) if (slots.get(id)?.row !== slot.row) moved++;
      moves.push(moved);
      slots = next;
    }
    // 2 initial placements, then a swap only once the 2s debounce lapses.
    const after = moves.slice(1).reduce((a, b) => a + b, 0);
    expect(after).toBeLessThanOrEqual(2);
  });
});
