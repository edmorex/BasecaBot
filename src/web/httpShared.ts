/**
 * Small shared bits for the web server + its route modules: the HTTP error type,
 * permission-label helpers, secret comparison, and the import size cap. Kept out
 * of `webServer.ts` so the `routes/*` modules can import them without a cycle.
 */
import { timingSafeEqual } from 'node:crypto';

export const LEVEL_LABELS = ['Everyone', 'Subscriber', 'VIP', 'Moderator', 'Broadcaster', 'Admin'];

/**
 * Constant-time comparison of a caller-supplied secret against a configured one,
 * so a wrong token cannot be guessed a character at a time by timing the replies.
 *
 * `timingSafeEqual` throws on a length mismatch, so an unequal length returns
 * early. That does leak the length, which is not a secret worth protecting: the
 * token is a fixed-length random string the operator chooses, and knowing how
 * long it is does not narrow the search usefully.
 *
 * A repeated header arrives as an array; anything that is not a single string is
 * refused rather than coerced, so `['a','b'].toString()` can never match.
 */
export function secretEquals(provided: string | string[] | undefined, configured: string): boolean {
  if (typeof provided !== 'string' || provided.length !== configured.length) return false;
  return timingSafeEqual(Buffer.from(provided), Buffer.from(configured));
}

/** CSV imports can be large. */
export const IMPORT_MAX_BYTES = 5 * 1024 * 1024;

/** Map a permission label ("Moderator"), restrict keyword ("mod"), or number to a level 0–5. */
export function labelToLevel(s: string): number {
  const t = s.trim().toLowerCase();
  if (/^\d+$/.test(t)) return Math.min(5, Math.max(0, Number(t)));
  const byLabel = LEVEL_LABELS.findIndex((l) => l.toLowerCase() === t);
  if (byLabel >= 0) return byLabel;
  const kw: Record<string, number> = { all: 0, sub: 1, mod: 3 };
  return kw[t] ?? 3;
}

/** Thrown by handlers to return a specific HTTP status with a JSON error. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
