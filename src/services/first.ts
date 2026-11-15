import type { Storage } from './storage/index.js';

/** How many places make up the board everything is scored against. */
export const TOP_N = 10;

/** Ranking points for a place: 1st = 10 … 10th = 1, nothing past 10th. */
export function pointsForPlace(place: number): number {
  return place >= 1 && place <= TOP_N ? TOP_N + 1 - place : 0;
}

/** A user's cumulative "!first" stats plus computed averages. */
export interface FirstStatView {
  userId: string;
  displayName: string;
  firsts: number;
  topTens: number;
  points: number;
  /** Average check-in seconds over top-10 finishes, or null if none. */
  avgTime: number | null;
  /** Average place over top-10 finishes, or null if none. */
  avgPlace: number | null;
}

/** One row of a leaderboard. */
export interface LeaderRow {
  displayName: string;
  /** The ranked value — a count, points total, or average seconds. */
  value: number;
}

/** One check-in in the current race, for the live overlay. */
export interface RaceEntry {
  place: number;
  name: string;
  avatarUrl: string | null;
  timeSeconds: number;
}

/** A snapshot of the current (most recent) race's standings. */
export interface RaceSnapshot {
  /** The stream/race key, or null if no one has ever checked in. */
  streamKey: string | null;
  entries: RaceEntry[];
}

/** A user's stats with their 1-based rank among all players for each metric. */
export interface FirstStatWithRanks extends FirstStatView {
  ranks: {
    firsts: number;
    topTens: number;
    points: number;
    avgTime: number | null; // null when the user has no timed finishes
    avgPlace: number | null;
  };
}

/** Outcome of a `!first` check-in. */
export type CheckInResult =
  | { repeat: true }
  | { repeat: false; place: number; timeSeconds: number; points: number };

/**
 * The outcome of a `!last` claim. 'full' is its own case rather than an error:
 * every top-10 place is taken, so there is nothing to claim and the command is
 * meant to do nothing.
 */
export type LastClaimResult =
  | { outcome: 'repeat' }
  | { outcome: 'full' }
  | { outcome: 'claimed'; place: number; timeSeconds: number; points: number };

/**
 * The "!first" race + all-time scoreboard. A race is scoped to a live stream via
 * `streamKey` (its start time); cumulative stats persist across streams.
 *
 * Concurrency: several claims can arrive at once, so place assignment is a single
 * atomic `INSERT … SELECT … WHERE NOT EXISTS`. SQLite serializes writers, so each
 * claim sees the prior ones and gets a unique place; the `(streamKey, userId)`
 * unique index makes a repeat a no-op — which is also what stops anyone holding
 * two places by mixing `!first` and `!last`.
 *
 * Places are no longer handed out as `COUNT(*) + 1`. `!first` takes the LOWEST
 * free place and `!last` the HIGHEST free one at or below `TOP_N`, so the two
 * commands fill the board from opposite ends and meet in the middle. Counting
 * rows would have put the first `!first` after a `!last` in place 2 with place 1
 * standing empty.
 */
export class FirstService {
  constructor(private readonly storage: Storage) {}

  private get db() {
    return this.storage.prisma;
  }

  /**
   * The streamKey of the race the overlay should currently show, or null when no
   * stream is live. Set by the first plugin's live monitor so the overlay clears
   * when the stream goes offline (rather than lingering until the next race). The
   * plugin and the web snapshot share one FirstService instance, so both agree.
   */
  private activeStreamKey: string | null = null;

  /** Point the overlay snapshot at a race (a live stream's key), or null (offline). */
  setActiveStream(streamKey: string | null): void {
    this.activeStreamKey = streamKey;
  }

  /**
   * Record a check-in for the current stream. The caller must have persisted the
   * user first (UsersService.touch) — check-ins reference User by foreign key.
   */
  async checkIn(userId: string, streamKey: string, timeSeconds: number): Promise<CheckInResult> {
    // The lowest place nobody holds. Identical to COUNT(*) + 1 while only !first
    // is in play, but it also steps over the places !last has taken from the top
    // end — and fills a gap left by a deleted account rather than colliding with
    // a place that is still held.
    //
    // The slot list is bounded by MAX(TOP_N, COUNT + 1): among that many slots at
    // least one must be free, because COUNT rows cannot fill COUNT + 1 places.
    const inserted = await this.db.$executeRaw`
      WITH RECURSIVE slot(x) AS (
        SELECT 1
        UNION ALL
        SELECT x + 1 FROM slot
        WHERE x < (SELECT MAX(${TOP_N}, COUNT(*) + 1) FROM "FirstCheckin" WHERE "streamKey" = ${streamKey})
      )
      INSERT INTO "FirstCheckin" ("streamKey", "userId", "place", "timeSeconds", "createdAt")
      SELECT ${streamKey}, ${userId},
             (SELECT MIN(x) FROM slot
               WHERE x NOT IN (SELECT "place" FROM "FirstCheckin" WHERE "streamKey" = ${streamKey})),
             ${timeSeconds}, CURRENT_TIMESTAMP
      WHERE NOT EXISTS (SELECT 1 FROM "FirstCheckin" WHERE "streamKey" = ${streamKey} AND "userId" = ${userId})
    `;
    if (inserted === 0) return { repeat: true }; // already claimed a place this stream

    const { place, timeSeconds: at } = await this.readPlace(streamKey, userId);
    await this.applyStats(userId, place, at);
    return { repeat: false, place, timeSeconds: at, points: pointsForPlace(place) };
  }

  /**
   * Claim the LAST place still free on the board — the highest number at or below
   * `TOP_N` that nobody holds, so the first caller takes 10th, the next 9th, and
   * so on until it meets the places `!first` has taken from the other end.
   *
   * Does nothing at all once the board is full; that is the point of the command
   * rather than a failure.
   */
  async claimLast(userId: string, streamKey: string, timeSeconds: number): Promise<LastClaimResult> {
    const inserted = await this.db.$executeRaw`
      WITH RECURSIVE slot(x) AS (
        SELECT 1 UNION ALL SELECT x + 1 FROM slot WHERE x < ${TOP_N}
      )
      INSERT INTO "FirstCheckin" ("streamKey", "userId", "place", "timeSeconds", "createdAt")
      SELECT ${streamKey}, ${userId},
             (SELECT MAX(x) FROM slot
               WHERE x NOT IN (SELECT "place" FROM "FirstCheckin" WHERE "streamKey" = ${streamKey})),
             ${timeSeconds}, CURRENT_TIMESTAMP
      WHERE NOT EXISTS (SELECT 1 FROM "FirstCheckin" WHERE "streamKey" = ${streamKey} AND "userId" = ${userId})
        AND (SELECT MAX(x) FROM slot
              WHERE x NOT IN (SELECT "place" FROM "FirstCheckin" WHERE "streamKey" = ${streamKey})) IS NOT NULL
    `;
    if (inserted === 0) {
      // Two reasons to insert nothing, and chat deserves different answers. Asked
      // after the fact rather than before, so the decision above stays atomic: a
      // row for this user means they already hold a place, and anything else
      // means there was none left.
      const held = await this.db.firstCheckin.findUnique({
        where: { streamKey_userId: { streamKey, userId } },
        select: { place: true },
      });
      return held ? { outcome: 'repeat' } : { outcome: 'full' };
    }

    const { place, timeSeconds: at } = await this.readPlace(streamKey, userId);
    await this.applyStats(userId, place, at);
    return { outcome: 'claimed', place, timeSeconds: at, points: pointsForPlace(place) };
  }

  /** The place a user just took, read back from the row the insert created. */
  private async readPlace(streamKey: string, userId: string): Promise<{ place: number; timeSeconds: number }> {
    const row = await this.db.firstCheckin.findUnique({
      where: { streamKey_userId: { streamKey, userId } },
      select: { place: true, timeSeconds: true },
    });
    return { place: row!.place, timeSeconds: row!.timeSeconds };
  }

  /**
   * Fold a claim into the cumulative scoreboard. Only top-10 places count, and
   * only place 1 is a literal "first" — so a 10th taken with !last is a top-10
   * finish worth one point, exactly as the same place reached with !first.
   */
  private async applyStats(userId: string, place: number, timeSeconds: number): Promise<void> {
    if (place > TOP_N) return;
    const points = pointsForPlace(place);
    const firsts = place === 1 ? 1 : 0;
    await this.db.$executeRaw`
      INSERT INTO "FirstStat" ("userId", "firsts", "topTens", "sumTimeSeconds", "sumPlace", "points")
      VALUES (${userId}, ${firsts}, 1, ${timeSeconds}, ${place}, ${points})
      ON CONFLICT ("userId") DO UPDATE SET
        "firsts" = "firsts" + ${firsts},
        "topTens" = "topTens" + 1,
        "sumTimeSeconds" = "sumTimeSeconds" + ${timeSeconds},
        "sumPlace" = "sumPlace" + ${place},
        "points" = "points" + ${points}
    `;
  }

  /**
   * The current race's standings for the live overlay: the top `limit` check-ins
   * (by place) of the ACTIVE race, with each user's display name + avatar. The
   * active race is whatever `setActiveStream` last pointed at — so it's empty
   * while the stream is offline and fills in as the live race is run.
   */
  async currentRace(limit = 10): Promise<RaceSnapshot> {
    const streamKey = this.activeStreamKey;
    if (!streamKey) return { streamKey: null, entries: [] };
    const rows = await this.db.firstCheckin.findMany({
      where: { streamKey },
      orderBy: { place: 'asc' },
      take: limit,
      include: { user: { select: { displayName: true, avatarUrl: true } } },
    });
    return {
      streamKey,
      entries: rows.map((r) => ({ place: r.place, name: r.user.displayName, avatarUrl: r.user.avatarUrl, timeSeconds: r.timeSeconds })),
    };
  }

  /** Every player's stats (small table — fetched whole for ranking/leaderboards). */
  private async allStats(): Promise<FirstStatView[]> {
    const rows = await this.db.firstStat.findMany({ include: { user: { select: { displayName: true } } } });
    return rows.map((r) => ({
      userId: r.userId,
      displayName: r.user.displayName,
      firsts: r.firsts,
      topTens: r.topTens,
      points: r.points,
      avgTime: r.topTens > 0 ? r.sumTimeSeconds / r.topTens : null,
      avgPlace: r.topTens > 0 ? r.sumPlace / r.topTens : null,
    }));
  }

  /** Top players by literal 1st-place finishes (desc). */
  async topFirsts(limit = 10): Promise<LeaderRow[]> {
    return (await this.allStats())
      .filter((s) => s.firsts > 0)
      .sort((a, b) => b.firsts - a.firsts || (b.points - a.points))
      .slice(0, limit)
      .map((s) => ({ displayName: s.displayName, value: s.firsts }));
  }

  /** Top players by cumulative ranking points (desc). */
  async topPoints(limit = 10): Promise<LeaderRow[]> {
    return (await this.allStats())
      .filter((s) => s.points > 0)
      .sort((a, b) => b.points - a.points || (b.firsts - a.firsts))
      .slice(0, limit)
      .map((s) => ({ displayName: s.displayName, value: s.points }));
  }

  /** Fastest players by average check-in time (asc); only those with timed finishes. */
  async topTime(limit = 10): Promise<LeaderRow[]> {
    return (await this.allStats())
      .filter((s): s is FirstStatView & { avgTime: number } => s.avgTime !== null)
      .sort((a, b) => a.avgTime - b.avgTime)
      .slice(0, limit)
      .map((s) => ({ displayName: s.displayName, value: s.avgTime }));
  }

  /** A user's stats with their rank in each metric, or null if they have no stats. */
  async statsFor(userId: string): Promise<FirstStatWithRanks | null> {
    const all = await this.allStats();
    const me = all.find((s) => s.userId === userId);
    if (!me) return null;

    // Higher-is-better metrics: rank = 1 + count strictly greater.
    const rankHigh = (get: (s: FirstStatView) => number) =>
      1 + all.filter((s) => get(s) > get(me)).length;
    // Lower-is-better averages, ranked only among users who have that average.
    const rankLow = (get: (s: FirstStatView) => number | null) => {
      const mine = get(me);
      if (mine === null) return null;
      return 1 + all.filter((s) => get(s) !== null && (get(s) as number) < mine).length;
    };

    return {
      ...me,
      ranks: {
        firsts: rankHigh((s) => s.firsts),
        topTens: rankHigh((s) => s.topTens),
        points: rankHigh((s) => s.points),
        avgTime: rankLow((s) => s.avgTime),
        avgPlace: rankLow((s) => s.avgPlace),
      },
    };
  }
}
