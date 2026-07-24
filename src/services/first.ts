import type { Storage } from './storage/index.js';

/** Ranking points for a place: 1st = 10 … 10th = 1, nothing past 10th. */
export function pointsForPlace(place: number): number {
  return place >= 1 && place <= 10 ? 11 - place : 0;
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
 * The "!first" race + all-time scoreboard. A race is scoped to a live stream via
 * `streamKey` (its start time); cumulative stats persist across streams.
 *
 * Concurrency: several `!first`s can arrive at once, so place assignment is a
 * single atomic `INSERT … SELECT COUNT(*)+1 … WHERE NOT EXISTS`. SQLite
 * serializes writers, so each check-in sees the prior ones and gets a unique,
 * ordered place; the `(streamKey, userId)` unique index makes a repeat a no-op.
 */
export class FirstService {
  constructor(private readonly storage: Storage) {}

  private get db() {
    return this.storage.prisma;
  }

  /**
   * Record a check-in for the current stream. The caller must have persisted the
   * user first (UsersService.touch) — check-ins reference User by foreign key.
   */
  async checkIn(userId: string, streamKey: string, timeSeconds: number): Promise<CheckInResult> {
    const inserted = await this.db.$executeRaw`
      INSERT INTO "FirstCheckin" ("streamKey", "userId", "place", "timeSeconds", "createdAt")
      SELECT ${streamKey}, ${userId},
             (SELECT COUNT(*) FROM "FirstCheckin" WHERE "streamKey" = ${streamKey}) + 1,
             ${timeSeconds}, CURRENT_TIMESTAMP
      WHERE NOT EXISTS (SELECT 1 FROM "FirstCheckin" WHERE "streamKey" = ${streamKey} AND "userId" = ${userId})
    `;
    if (inserted === 0) return { repeat: true }; // already checked in this stream

    const row = await this.db.firstCheckin.findUnique({
      where: { streamKey_userId: { streamKey, userId } },
      select: { place: true, timeSeconds: true },
    });
    const place = row!.place;
    const points = pointsForPlace(place);

    // Only top-10 finishes touch the cumulative stats.
    if (place <= 10) {
      await this.db.$executeRaw`
        INSERT INTO "FirstStat" ("userId", "firsts", "topTens", "sumTimeSeconds", "sumPlace", "points")
        VALUES (${userId}, ${place === 1 ? 1 : 0}, 1, ${timeSeconds}, ${place}, ${points})
        ON CONFLICT ("userId") DO UPDATE SET
          "firsts" = "firsts" + ${place === 1 ? 1 : 0},
          "topTens" = "topTens" + 1,
          "sumTimeSeconds" = "sumTimeSeconds" + ${timeSeconds},
          "sumPlace" = "sumPlace" + ${place},
          "points" = "points" + ${points}
      `;
    }

    return { repeat: false, place, timeSeconds: row!.timeSeconds, points };
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
