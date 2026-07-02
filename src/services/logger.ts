import pino from 'pino';

const level = process.env.LOG_LEVEL ?? 'info';

/**
 * Root structured logger. Pretty-prints in dev; emits JSON in production
 * (set NODE_ENV=production) so logs are cheap to ship to a server later.
 */
export const logger = pino({
  level,
  transport:
    process.env.NODE_ENV === 'production'
      ? undefined
      : {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname' },
        },
});

/** Create a child logger scoped to a component (e.g. a plugin name). */
export function scopedLogger(scope: string): pino.Logger {
  return logger.child({ scope });
}

export type Logger = pino.Logger;
