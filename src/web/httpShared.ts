/**
 * Small shared bits for the web server + its route modules: the HTTP error type,
 * permission-label helpers, and the import size cap. Kept out of `webServer.ts`
 * so the `routes/*` modules can import them without a cycle.
 */

export const LEVEL_LABELS = ['Everyone', 'Subscriber', 'VIP', 'Moderator', 'Broadcaster', 'Admin'];

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
