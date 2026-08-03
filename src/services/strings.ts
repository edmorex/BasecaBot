/**
 * Small, pure string helpers shared across plugins (no dependencies). Kept
 * separate from `textStrings.ts` (the admin-editable string SERVICE) — these are
 * just formatting utilities.
 */

/** English pluralization: pick the singular or plural form by count. */
export function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

/**
 * Split the leading whitespace-delimited token from the remaining (trimmed)
 * text — e.g. a quote/timer id or a subcommand argument and its value.
 */
export function firstAndRest(input: string): { first: string; rest: string } {
  const s = input.trim();
  const i = s.indexOf(' ');
  if (i === -1) return { first: s, rest: '' };
  return { first: s.slice(0, i), rest: s.slice(i + 1).trim() };
}

/** A duration in ms as a human string, e.g. "2 hours 15 minutes" (minutes always shown). */
export function humanDuration(ms: number): string {
  if (ms < 0) ms = 0;
  const totalMin = Math.floor(ms / 60000);
  const days = Math.floor(totalMin / 1440);
  const hours = Math.floor((totalMin % 1440) / 60);
  const mins = totalMin % 60;
  const parts: string[] = [];
  if (days) parts.push(`${days} ${plural(days, 'day', 'days')}`);
  if (hours) parts.push(`${hours} ${plural(hours, 'hour', 'hours')}`);
  parts.push(`${mins} ${plural(mins, 'minute', 'minutes')}`);
  return parts.join(' ');
}
