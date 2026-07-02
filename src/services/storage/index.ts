import { PrismaClient } from '@prisma/client';
import { scopedLogger } from '../logger.js';

const log = scopedLogger('storage');

/**
 * Thin wrapper around the Prisma client. This is the ONLY module that knows
 * which database engine is in use — swapping SQLite for Postgres is a
 * schema `provider` + `DATABASE_URL` change, no query rewrites elsewhere.
 */
export class Storage {
  readonly prisma: PrismaClient;

  constructor(prisma: PrismaClient = new PrismaClient()) {
    this.prisma = prisma;
  }

  async connect(): Promise<void> {
    await this.prisma.$connect();
    log.info('database connected');
  }

  async disconnect(): Promise<void> {
    await this.prisma.$disconnect();
    log.info('database disconnected');
  }
}
