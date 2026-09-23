import { describe, it, expect } from 'vitest';
import { resolveCombat, cleanEmoteNames, speedForHp, glowForHp, type EmoteLists } from './bossCombat.js';

const lists: EmoteLists = {
  hurt: new Set(['Kappa', 'PogChamp']),
  heal: new Set(['HeyGuys']),
};
const em = (name: string, count = 1) => ({ name, count });

describe('resolveCombat', () => {
  it('deals one damage per DISTINCT vulnerable emote', () => {
    expect(resolveCombat([em('Kappa'), em('PogChamp')], lists, false)).toEqual({
      damage: 2, heal: 0, misses: 0, landed: true,
    });
  });

  it('treats repeats of the same emote as misses, so spam does not out-damage variety', () => {
    // Kappa x3 -> one hit, two wasted shots.
    expect(resolveCombat([em('Kappa', 3)], lists, false)).toEqual({
      damage: 1, heal: 0, misses: 2, landed: true,
    });
  });

  it('counts emotes the boss is immune to as misses', () => {
    expect(resolveCombat([em('Kappa'), em('LUL', 2)], lists, false)).toEqual({
      damage: 1, heal: 0, misses: 2, landed: true,
    });
  });

  it('heals on healing emotes and still lands (so defenders share the cooldown)', () => {
    const r = resolveCombat([em('HeyGuys')], lists, false);
    expect(r).toEqual({ damage: 0, heal: 1, misses: 0, landed: true });
  });

  it('lets one message both damage and heal', () => {
    expect(resolveCombat([em('Kappa'), em('HeyGuys')], lists, false)).toEqual({
      damage: 1, heal: 1, misses: 0, landed: true,
    });
  });

  it('turns EVERYTHING into a miss while the sender is on cooldown', () => {
    const r = resolveCombat([em('Kappa', 2), em('HeyGuys')], lists, true);
    expect(r).toEqual({ damage: 0, heal: 0, misses: 3, landed: false });
    expect(r.landed).toBe(false); // a blocked message must not re-arm the cooldown
  });

  it('is case-sensitive, matching how Twitch names emotes', () => {
    expect(resolveCombat([em('kappa')], lists, false)).toMatchObject({ damage: 0, misses: 1 });
  });

  it('resolves an emote on both lists as damage only, never double-counted', () => {
    const both: EmoteLists = { hurt: new Set(['Kappa']), heal: new Set(['Kappa']) };
    expect(resolveCombat([em('Kappa')], both, false)).toEqual({ damage: 1, heal: 0, misses: 0, landed: true });
  });

  it('does nothing for a message with no emotes', () => {
    expect(resolveCombat([], lists, false)).toEqual({ damage: 0, heal: 0, misses: 0, landed: false });
  });

  it('ignores junk entries rather than counting them', () => {
    const r = resolveCombat([em('', 5), em('Kappa', 0), em('PogChamp')], lists, false);
    expect(r).toEqual({ damage: 1, heal: 0, misses: 0, landed: true });
  });

  it('de-duplicates an emote name reported twice in one message', () => {
    expect(resolveCombat([em('Kappa'), em('Kappa')], lists, false)).toEqual({
      damage: 1, heal: 0, misses: 1, landed: true,
    });
  });
});

describe('cleanEmoteNames', () => {
  it('trims, drops blanks, and de-duplicates', () => {
    expect(cleanEmoteNames([' Kappa ', 'Kappa', '', '   ', 'LUL'])).toEqual(['Kappa', 'LUL']);
  });

  it('keeps case variants as separate emotes', () => {
    expect(cleanEmoteNames(['Kappa', 'kappa'])).toEqual(['Kappa', 'kappa']);
  });

  it('caps the list', () => {
    expect(cleanEmoteNames(Array.from({ length: 40 }, (_, i) => 'e' + i)).length).toBe(25);
  });

  it('returns empty for non-arrays', () => {
    expect(cleanEmoteNames(null)).toEqual([]);
    expect(cleanEmoteNames('Kappa')).toEqual([]);
  });
});

describe('speedForHp', () => {
  it('uses the full-health speed at full health and the near-death speed at 1 HP', () => {
    expect(speedForHp(20, 20, 9, 2)).toBe(9);
    expect(speedForHp(1, 20, 9, 2)).toBe(2);
  });

  it('interpolates linearly in between', () => {
    expect(speedForHp(10, 19, 10, 2)).toBeCloseTo(6, 5); // exactly halfway
  });

  it('supports a boss that speeds UP as it weakens', () => {
    expect(speedForHp(1, 10, 2, 9)).toBe(9);
  });

  it('clamps out-of-range health', () => {
    expect(speedForHp(99, 20, 9, 2)).toBe(9);
    expect(speedForHp(0, 20, 9, 2)).toBe(2);
    expect(speedForHp(1, 1, 9, 2)).toBe(2); // a 1 HP boss has no ramp to walk
  });
});

describe('glowForHp', () => {
  it('runs green -> yellow -> red as health drains', () => {
    expect(glowForHp(20, 20)).toBe('green');
    expect(glowForHp(14, 20)).toBe('green');
    expect(glowForHp(13, 20)).toBe('yellow');
    expect(glowForHp(7, 20)).toBe('yellow');
    expect(glowForHp(6, 20)).toBe('red');
    expect(glowForHp(0, 20)).toBe('red');
  });
});
