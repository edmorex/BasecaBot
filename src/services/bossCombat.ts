/**
 * Boss Battle combat resolution — pure, synchronous, and dependency-free.
 *
 * Everything that decides how much a chat message hurts (or heals) a boss lives
 * here so it can be unit-tested without a chat connection, a database or a
 * browser. The plugin owns the state machine; this module owns the RULES.
 *
 * The rules, in one place:
 *  - Damage is the number of DISTINCT vulnerable emotes in the message. Sending
 *    the same emote three times is one hit and two misses, so variety beats spam.
 *  - Healing works the same way, counting distinct healing emotes.
 *  - Every other emote instance in the message is a miss (an emote the boss is
 *    immune to, or a repeat of one already counted).
 *  - While a user is on cooldown, nothing they send lands: damage and healing are
 *    both zero and every emote instance is a miss. Attackers and defenders are
 *    rate-limited identically, so neither side can out-spam the other.
 */

/** A boss's emote vulnerabilities, pre-split for lookup. */
export interface EmoteLists {
  /** Emotes that damage the boss (public + private merged — the split is presentational). */
  hurt: ReadonlySet<string>;
  /** Emotes that heal the boss. */
  heal: ReadonlySet<string>;
}

/** One emote occurrence group from a chat message (as Twitch's IRC tags report it). */
export interface MessageEmote {
  name: string;
  /** How many times this emote appears in the message. */
  count: number;
}

/** What a single message did to the boss. */
export interface CombatResult {
  /** HP removed. */
  damage: number;
  /** HP restored. */
  heal: number;
  /** Emote instances that did nothing. */
  misses: number;
  /** True when this message should start the sender's cooldown. */
  landed: boolean;
}

export const NO_EFFECT: CombatResult = { damage: 0, heal: 0, misses: 0, landed: false };

/**
 * Resolve one chat message against a boss.
 *
 * `onCooldown` is decided by the caller (it owns the clock); when true this
 * degrades to "every emote is a miss" without consulting the lists at all.
 *
 * An emote listed as BOTH hurtful and healing counts as damage only — the
 * attacking reading wins, and it is never double-counted as a miss.
 */
export function resolveCombat(emotes: readonly MessageEmote[], lists: EmoteLists, onCooldown: boolean): CombatResult {
  let damage = 0;
  let heal = 0;
  let total = 0;
  // Twitch can report the same emote id twice in odd cases; de-duplicate by name
  // so a distinct-emote rule can't be gamed.
  const counted = new Set<string>();

  for (const e of emotes) {
    const name = String(e?.name ?? '');
    const count = Math.max(0, Math.floor(Number(e?.count) || 0));
    if (!name || count === 0) continue;
    total += count;
    if (onCooldown || counted.has(name)) continue;
    counted.add(name);
    if (lists.hurt.has(name)) damage++;
    else if (lists.heal.has(name)) heal++;
  }

  const landed = damage > 0 || heal > 0;
  return { damage, heal, misses: total - damage - heal, landed };
}

/**
 * Clean a raw emote-name list from the admin panel: trim, drop blanks, drop
 * duplicates, and cap it.
 *
 * Matching is CASE-SENSITIVE because Twitch emote names are — `Kappa` and
 * `kappa` are not the same emote, and silently folding them would make a boss
 * vulnerable to something the streamer never configured.
 */
export function cleanEmoteNames(list: unknown, max = 25): string[] {
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  for (const raw of list) {
    const name = String(raw ?? '').trim().slice(0, 40);
    if (name && !out.includes(name)) out.push(name);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Interpolate a boss's movement speed from its remaining health.
 *
 * `speedFull` applies at full HP and `speedNearDeath` at 1 HP, linearly between.
 * The direction is deliberately NOT assumed: a boss can be configured to start
 * fast and calm down, or to grow frantic as it weakens.
 */
export function speedForHp(remaining: number, max: number, speedFull: number, speedNearDeath: number): number {
  if (max <= 1) return speedNearDeath;
  const hp = Math.min(max, Math.max(1, remaining));
  const t = (max - hp) / (max - 1); // 0 at full health, 1 at a single point left
  return speedFull + (speedNearDeath - speedFull) * t;
}

/**
 * Which glow tier a boss is in: green while it is healthy, yellow through the
 * middle third, red for the last third. (Deliberately the reverse of Pet the
 * Floof's boss, where the colour tracks danger to the FLOOF, not to chat.)
 */
export function glowForHp(remaining: number, max: number): 'green' | 'yellow' | 'red' {
  const r = max > 0 ? remaining / max : 0;
  if (r > 2 / 3) return 'green';
  if (r > 1 / 3) return 'yellow';
  return 'red';
}
