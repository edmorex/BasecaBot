import type { Storage } from './storage/index.js';

export class InsufficientPointsError extends Error {
  constructor(
    readonly balance: number,
    readonly requested: number,
  ) {
    super(`Insufficient points: have ${balance}, need ${requested}`);
    this.name = 'InsufficientPointsError';
  }
}

/**
 * The loyalty economy. Mutations are expressed as single atomic SQL statements
 * (upsert-with-increment / conditional update) rather than read-then-write, so
 * concurrent awards/spends can't clobber each other AND they don't deadlock
 * SQLite the way interactive transactions do. The same SQL works on Postgres.
 *
 * The user must already exist (call UsersService.touch first) — points rows
 * reference User by foreign key.
 */
export class PointsService {
  constructor(private readonly storage: Storage) {}

  async getBalance(userId: string, channel: string): Promise<number> {
    const row = await this.storage.prisma.pointsBalance.findUnique({
      where: { userId_channel: { userId, channel } },
    });
    return row?.balance ?? 0;
  }

  /**
   * Add points (or subtract with a negative amount, floored at zero) in one
   * atomic upsert. Concurrency-safe: N parallel awards sum correctly.
   */
  async award(userId: string, channel: string, amount: number): Promise<number> {
    await this.storage.prisma.$executeRaw`
      INSERT INTO "PointsBalance" ("userId", "channel", "balance")
      VALUES (${userId}, ${channel}, MAX(0, ${amount}))
      ON CONFLICT ("userId", "channel")
      DO UPDATE SET "balance" = MAX(0, "balance" + ${amount})
    `;
    return this.getBalance(userId, channel);
  }

  /**
   * Award points but never push the balance above `cap` (an accrual cap). A
   * balance already at/above the cap is left unchanged; otherwise it rises to at
   * most `cap`. Atomic; safe for the periodic payout loop.
   */
  async awardCapped(userId: string, channel: string, amount: number, cap: number): Promise<number> {
    await this.storage.prisma.$executeRaw`
      INSERT INTO "PointsBalance" ("userId", "channel", "balance")
      VALUES (${userId}, ${channel}, MIN(${cap}, MAX(0, ${amount})))
      ON CONFLICT ("userId", "channel")
      DO UPDATE SET "balance" = CASE
        WHEN "balance" >= ${cap} THEN "balance"
        ELSE MIN(${cap}, "balance" + ${amount})
      END
    `;
    return this.getBalance(userId, channel);
  }

  /** Spend points atomically; throws InsufficientPointsError if too poor. */
  async spend(userId: string, channel: string, amount: number): Promise<number> {
    if (amount < 0) throw new Error('spend amount must be non-negative');
    if (amount === 0) return this.getBalance(userId, channel);
    const affected = await this.storage.prisma.$executeRaw`
      UPDATE "PointsBalance" SET "balance" = "balance" - ${amount}
      WHERE "userId" = ${userId} AND "channel" = ${channel} AND "balance" >= ${amount}
    `;
    if (affected === 0) {
      throw new InsufficientPointsError(await this.getBalance(userId, channel), amount);
    }
    return this.getBalance(userId, channel);
  }

  /** Move points between two users atomically. */
  async transfer(fromUserId: string, toUserId: string, channel: string, amount: number): Promise<void> {
    if (amount <= 0) throw new Error('transfer amount must be positive');
    await this.storage.prisma.$transaction(async (tx) => {
      const debited = await tx.$executeRaw`
        UPDATE "PointsBalance" SET "balance" = "balance" - ${amount}
        WHERE "userId" = ${fromUserId} AND "channel" = ${channel} AND "balance" >= ${amount}
      `;
      if (debited === 0) {
        const row = await tx.pointsBalance.findUnique({
          where: { userId_channel: { userId: fromUserId, channel } },
        });
        throw new InsufficientPointsError(row?.balance ?? 0, amount);
      }
      await tx.$executeRaw`
        INSERT INTO "PointsBalance" ("userId", "channel", "balance")
        VALUES (${toUserId}, ${channel}, ${amount})
        ON CONFLICT ("userId", "channel")
        DO UPDATE SET "balance" = "balance" + ${amount}
      `;
    });
  }

  /** Top N balances in a channel, joined with display names. */
  async leaderboard(channel: string, limit = 10) {
    const rows = await this.storage.prisma.pointsBalance.findMany({
      where: { channel },
      orderBy: { balance: 'desc' },
      take: limit,
      include: { user: true },
    });
    return rows.map((r) => ({ displayName: r.user.displayName, balance: r.balance }));
  }
}
