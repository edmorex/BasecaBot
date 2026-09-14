import { describe, it, expect } from 'vitest';
import { ChatStatsAggregator } from './aggregator.js';

/** Build an entry `msAgo` before `now`. */
function entry(now: number, msAgo: number, userId: string, name: string, emotes: { name: string; count: number }[] = []) {
  return { ts: now - msAgo, userId, name, emotes };
}

describe('ChatStatsAggregator', () => {
  it('counts messages, unique chatters, and emotes per window', () => {
    const now = 1_000_000;
    const agg = new ChatStatsAggregator();
    // Added oldest-first (chat arrives chronologically).
    agg.add('c', entry(now, 40_000, 'u1', 'Alice', [{ name: 'Kappa', count: 1 }])); // outside 30s/10s, inside 1m
    agg.add('c', entry(now, 5_000, 'u2', 'Bob', [{ name: 'PogChamp', count: 1 }]));
    agg.add('c', entry(now, 2_000, 'u1', 'Alice', [{ name: 'Kappa', count: 2 }]));

    const windows = agg.compute('c', now);
    const w = (label: string) => windows.find((x) => x.label === label)!.stats;

    // 10s: only the first two messages.
    expect(w('10s').messages).toBe(2);
    expect(w('10s').uniqueChatters).toBe(2);
    expect(w('10s').totalEmotes).toBe(3); // 2 Kappa + 1 PogChamp
    expect(w('10s').uniqueEmotes).toBe(2);
    expect(w('10s').topEmote).toEqual({ name: 'Kappa', count: 2 });

    // 30s: same two (40s-old one excluded).
    expect(w('30s').messages).toBe(2);
    // 1m: all three; Alice has 2 messages + 3 Kappa total.
    expect(w('1m').messages).toBe(3);
    expect(w('1m').uniqueChatters).toBe(2);
    expect(w('1m').topEmote).toEqual({ name: 'Kappa', count: 3 });
  });

  it('ranks top chatters by messages and by emotes (top 3, count desc)', () => {
    const now = 2_000_000;
    const agg = new ChatStatsAggregator();
    // Alice: 3 msgs, 1 emote; Bob: 1 msg, 5 emotes; Cara: 2 msgs, 0 emotes.
    agg.add('c', entry(now, 100, 'a', 'Alice', [{ name: 'x', count: 1 }]));
    agg.add('c', entry(now, 100, 'a', 'Alice'));
    agg.add('c', entry(now, 100, 'a', 'Alice'));
    agg.add('c', entry(now, 100, 'b', 'Bob', [{ name: 'x', count: 5 }]));
    agg.add('c', entry(now, 100, 'c', 'Cara'));
    agg.add('c', entry(now, 100, 'c', 'Cara'));

    const s = agg.compute('c', now).find((x) => x.label === '10s')!.stats;
    expect(s.topByMessages.map((t) => t.name)).toEqual(['Alice', 'Cara', 'Bob']); // 3, 2, 1
    expect(s.topByMessages[0]).toEqual({ name: 'Alice', count: 3 });
    expect(s.topByEmotes[0]).toEqual({ name: 'Bob', count: 5 }); // only emote users ranked
    expect(s.topByEmotes.map((t) => t.name)).toEqual(['Bob', 'Alice']);
  });

  it('prunes entries older than the widest window and isolates channels', () => {
    const now = 3_000_000;
    const agg = new ChatStatsAggregator();
    agg.add('c', entry(now, 400_000, 'old', 'Old')); // older than 5m → pruned on next add
    agg.add('c', entry(now, 1_000, 'u1', 'Now'));
    agg.add('other', entry(now, 1_000, 'u2', 'Other'));

    expect(agg.compute('c', now).find((x) => x.label === '5m')!.stats.messages).toBe(1);
    expect(agg.compute('other', now).find((x) => x.label === '5m')!.stats.messages).toBe(1);
    expect(agg.compute('missing', now).find((x) => x.label === '5m')!.stats.messages).toBe(0);
  });

  it('reports zeros / nulls for an empty window', () => {
    const s = new ChatStatsAggregator().compute('c', 0).find((x) => x.label === '10s')!.stats;
    expect(s).toMatchObject({ messages: 0, uniqueChatters: 0, totalEmotes: 0, uniqueEmotes: 0, topEmote: null, topByMessages: [], topByEmotes: [] });
  });
});
