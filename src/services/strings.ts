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
