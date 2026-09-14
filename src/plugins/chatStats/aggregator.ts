/**
 * Rolling chat-activity aggregation for the stats overlay. Pure logic (no I/O):
 * the plugin feeds it chat entries and asks it to compute windowed stats.
 */

/** One recorded chat message. */
export interface StatEntry {
  ts: number;
  userId: string;
  /** Display name to show in the top-chatter lists. */
  name: string;
  /** Emotes used in this message (name + how many times). */
  emotes: { name: string; count: number }[];
}

/** A name/count pair for the top-N lists and the top emote. */
export interface NameCount {
  name: string;
  count: number;
}

/** Computed stats for one time window. */
export interface WindowStats {
  messages: number;
  uniqueChatters: number;
  totalEmotes: number;
  uniqueEmotes: number;
  topEmote: NameCount | null;
  topByMessages: NameCount[]; // up to 3
  topByEmotes: NameCount[]; // up to 3
}

/** The time windows shown as columns, in order. */
export const STAT_WINDOWS: { label: string; seconds: number }[] = [
  { label: '10s', seconds: 10 },
  { label: '30s', seconds: 30 },
  { label: '1m', seconds: 60 },
  { label: '5m', seconds: 300 },
];

const MAX_WINDOW_MS = Math.max(...STAT_WINDOWS.map((w) => w.seconds)) * 1000;
const TOP_N = 3;

/** Sort name/count pairs by count desc, then name asc, and take the top N. */
function topN(map: Map<string, NameCount>, n = TOP_N): NameCount[] {
  return [...map.values()]
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, n);
}

export class ChatStatsAggregator {
  /** Recent entries per channel, oldest-first, pruned to the widest window. */
  private readonly byChannel = new Map<string, StatEntry[]>();

  /** Record a message; prunes entries older than the widest window. */
  add(channel: string, entry: StatEntry): void {
    let buf = this.byChannel.get(channel);
    if (!buf) {
      buf = [];
      this.byChannel.set(channel, buf);
    }
    buf.push(entry);
    const cutoff = entry.ts - MAX_WINDOW_MS;
    while (buf.length && buf[0]!.ts < cutoff) buf.shift();
  }

  /** Compute stats for every window for `channel` as of `now`. */
  compute(channel: string, now: number = Date.now()): { label: string; stats: WindowStats }[] {
    const buf = this.byChannel.get(channel) ?? [];
    return STAT_WINDOWS.map((w) => {
      const from = now - w.seconds * 1000;
      // buf is oldest-first; find the first in-window index.
      let i = buf.length;
      while (i > 0 && buf[i - 1]!.ts >= from) i--;
      return { label: w.label, stats: windowStats(buf.slice(i)) };
    });
  }
}

/** Reduce a set of in-window entries to the displayed stats. */
function windowStats(entries: StatEntry[]): WindowStats {
  const chatters = new Set<string>();
  const emoteTotals = new Map<string, number>(); // emote name -> total uses
  const byMessages = new Map<string, NameCount>(); // userId -> {name, msg count}
  const byEmotes = new Map<string, NameCount>(); // userId -> {name, emote count}
  let totalEmotes = 0;

  for (const e of entries) {
    chatters.add(e.userId);

    const m = byMessages.get(e.userId) ?? { name: e.name, count: 0 };
    m.name = e.name; // keep the latest display name
    m.count++;
    byMessages.set(e.userId, m);

    let msgEmotes = 0;
    for (const em of e.emotes) {
      emoteTotals.set(em.name, (emoteTotals.get(em.name) ?? 0) + em.count);
      msgEmotes += em.count;
    }
    if (msgEmotes) {
      totalEmotes += msgEmotes;
      const x = byEmotes.get(e.userId) ?? { name: e.name, count: 0 };
      x.name = e.name;
      x.count += msgEmotes;
      byEmotes.set(e.userId, x);
    }
  }

  let topEmote: NameCount | null = null;
  for (const [name, count] of emoteTotals) {
    if (!topEmote || count > topEmote.count || (count === topEmote.count && name.localeCompare(topEmote.name) < 0)) {
      topEmote = { name, count };
    }
  }

  return {
    messages: entries.length,
    uniqueChatters: chatters.size,
    totalEmotes,
    uniqueEmotes: emoteTotals.size,
    topEmote,
    topByMessages: topN(byMessages),
    topByEmotes: topN(byEmotes),
  };
}
