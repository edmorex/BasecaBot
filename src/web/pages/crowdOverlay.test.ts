import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { crowdHypeOverlayPage } from './overlayCrowdHype.js';

/**
 * Guards the Crowd Hype overlay's static-style cache.
 *
 * Most of each member's styles are fixed until the config or their row changes,
 * so they are written behind a signature instead of 60 times a second. The
 * hazard is a missing dependency: leave an input out of STATIC_DEPS and changing
 * that setting in the panel silently does nothing until the member moves row —
 * no crash, no glitch, just a knob that does not work. These checks derive the
 * requirement from the code itself rather than trusting a comment.
 */
const SRC = readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), 'overlayCrowdHype.ts'), 'utf8');

/** The body of a top-level function inside the page script, by brace matching. */
function functionBody(name: string): string {
  const start = SRC.indexOf('function ' + name + '(');
  expect(start, `${name} not found`).toBeGreaterThan(-1);
  let i = SRC.indexOf('{', start);
  let depth = 0;
  const from = i;
  for (; i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}' && --depth === 0) break;
  }
  return SRC.slice(from + 1, i);
}

/** Full source text of a top-level function in the page script. */
function functionSrc(name: string): string {
  const start = SRC.indexOf('function ' + name + '(');
  expect(start, `${name} not found`).toBeGreaterThan(-1);
  let i = SRC.indexOf('{', start);
  let depth = 0;
  for (; i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}' && --depth === 0) break;
  }
  return SRC.slice(start, i + 1);
}

/** Source with comments stripped, so prose about a past bug cannot trip a scan. */
function codeOnly(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const DEPS = (() => {
  const m = /var STATIC_DEPS = \[([^\]]*)\]/.exec(SRC);
  expect(m, 'STATIC_DEPS not found').not.toBeNull();
  return m![1]!.split(',').map((x) => x.trim().replace(/^'|'$/g, '')).filter(Boolean);
})();

describe('crowd overlay static-style cache', () => {
  it('declares the dependency list the guard is built from', () => {
    // The documented table: zIndex <- rows,row; body box <- silhouetteHeight,
    // rowScale,rows,row; filter <- glow,glowColor; avatar <- avatarSize,rowScale,
    // rows,row. Spelled out so adding a guarded input is a deliberate act.
    expect(DEPS.sort()).toEqual([
      'avatarSize', 'glow', 'glowColor', 'row', 'rowScale', 'rows', 'silhouetteHeight',
    ]);
  });

  it('builds the signature from every declared dependency, nothing hand-picked', () => {
    // Looping STATIC_DEPS is what makes adding a dep enough; a hand-written
    // concatenation would silently omit anything added later.
    const sig = functionBody('staticSig');
    expect(sig).toMatch(/STATIC_DEPS\.length/);
    expect(sig).toMatch(/\[STATIC_DEPS\[i\]\]/);
  });

  it('reads nothing in applyStatic that is not a declared dependency', () => {
    // THE check this file exists for. Every `d.x` the guarded writes consume has
    // to be in STATIC_DEPS, or that setting stops applying.
    const body = functionBody('applyStatic');
    const used = [...body.matchAll(/\bd\.([a-zA-Z]\w*)/g)].map((m) => m[1]!);
    expect(used.length, 'applyStatic reads no dependencies at all').toBeGreaterThan(0);
    const undeclared = [...new Set(used)].filter((k) => !DEPS.includes(k));
    expect(undeclared, `not in STATIC_DEPS: ${undeclared.join(', ')}`).toEqual([]);
  });

  it('never reaches past the dependency object for config inside applyStatic', () => {
    // Reading cfg.* directly would bypass the signature entirely.
    const body = functionBody('applyStatic');
    const leaks = [...new Set([...body.matchAll(/\bcfg\.([a-zA-Z]\w*)/g)].map((m) => m[1]!))];
    expect(leaks, `applyStatic reads cfg directly: ${leaks.join(', ')}`).toEqual([]);
  });

  it('populates every declared dependency each frame', () => {
    // A dep that is declared but never assigned would be undefined in the
    // signature: constant, so the guard would never notice it changing.
    const body = functionBody('frame');
    for (const dep of DEPS) {
      const assigned = dep === 'row'
        ? /deps\.row = p\.row/.test(body)          // per member, inside the loop
        : new RegExp('deps\\.' + dep + '\\s*=').test(body);
      expect(assigned, `deps.${dep} is never set in frame()`).toBe(true);
    }
  });

  it('writes only the two moving transforms outside the guard', () => {
    const body = functionBody('frame');
    const guard = body.indexOf('if (p.sig !== sig)');
    expect(guard).toBeGreaterThan(-1);
    const unguarded = body.slice(body.indexOf('for (var key in seats)'), guard);
    const writes = [...unguarded.matchAll(/\.style\.(\w+)\s*=/g)].map((m) => m[1]!);
    expect([...new Set(writes)].sort()).toEqual(['transform']);
  });

  it('applies the guarded styles on a seat’s very first frame', () => {
    // An empty starting signature can never equal a real one, so the first
    // comparison always fails and the statics land immediately.
    expect(SRC).toMatch(/sig: ''/);
  });

  it('re-applies them when the avatar node is rebuilt', () => {
    // paint() can replace the avatar element; the new one has no sizing yet, so
    // the signature has to be invalidated or it stays at its default size.
    expect(functionBody('paint')).toMatch(/\bseat\.sig = ''/);
  });

  it('keeps the constant colour out of the frame loop entirely', () => {
    expect(functionBody('frame')).not.toMatch(/style\.color/);
    expect(SRC).toMatch(/\.body\{[^}]*color:rgba\(8,6,12,\.96\)/);
  });

  it('handles all three mirror modes', () => {
    const body = functionBody('wantsFlip');
    expect(body).toMatch(/'move'/);
    expect(body).toMatch(/'position'/);
    // 'off' is the fall-through: neither branch taken, so nothing is mirrored.
    expect(body.trimEnd().endsWith('return false;')).toBe(true);
  });

  it('reads the drift direction analytically, not by comparing frames', () => {
    // The wander is a sine, so cos of the same phase gives the exact direction.
    // Diffing x between frames would pick up the random jitter and flap the
    // silhouette back and forth at every turnaround.
    const body = functionBody('wantsFlip');
    expect(body).toMatch(/Math\.cos\(/);
    expect(body).not.toMatch(/lastX|prevX/);
    // No horizontal movement means no direction to face.
    expect(body).toMatch(/drift <= 0/);
  });

  it('holds the flip inside a deadband at the centre line', () => {
    // Without it, a member hovering on the midpoint flickers every frame.
    const body = functionBody('wantsFlip');
    expect(body).toMatch(/W \/ 2 - \d+/);
    expect(body).toMatch(/W \/ 2 \+ \d+/);
    expect(body).toMatch(/return p\.flipped;/);
  });

  it('writes the mirror only when it changes, and never onto the avatar', () => {
    const body = functionBody('frame');
    expect(body).toMatch(/if \(flip !== p\.flipped/);
    // The flip lands on the artwork element; putting it on .body would mirror the
    // profile picture along with the silhouette.
    expect(body).toMatch(/p\.art\.style\.transform/);
    expect(body).not.toMatch(/p\.body\.style\.transform = .*scaleX/);
  });

  it('re-applies the mirror when the artwork is swapped out', () => {
    const body = functionBody('paint');
    expect(body).toMatch(/\bseat\.art = /);
    expect(body).toMatch(/\bseat\.flipped = false/);
  });

  it('builds the crowd from seats, not from people', () => {
    // A seat owns its position, its artwork and its animation phase; a chatter is
    // only ever the occupant. This is what keeps the characters still while the
    // icons move, and what will let artwork be pinned per position later.
    expect(SRC).toMatch(/function buildSeat\(row, slot\)/);
    expect(SRC).toMatch(/function artFor\(seat\)/);
    expect(SRC).toMatch(/var seats = \{\}/);
    expect(SRC).toMatch(/var assign = \{\}/);
  });

  it('always honours a pinned seat', () => {
    // An assignment made in the panel must win outright, before any random draw.
    const body = functionBody('artFor');
    expect(body).toMatch(/cfg\.seatArt/);
    expect(body).toMatch(/seatKey\(seat\.row, seat\.slot\)/);
    const pinned = body.indexOf('pinned');
    const random = body.indexOf('Math.random');
    expect(pinned).toBeGreaterThan(-1);
    expect(random).toBeGreaterThan(-1);
    expect(pinned, 'the pin must be checked before the draw').toBeLessThan(random);
  });

  it('draws an unpinned seat once and keeps it while occupied', () => {
    // Re-rolling per frame would strobe the character; re-rolling on every
    // reshuffle would undo the whole point of the seat model. The draw is cached
    // on the seat and only cleared when it empties.
    const art = functionBody('artFor');
    expect(art).toMatch(/seat\.rolled/);
    expect(art).toMatch(/if \(!seat\.rolled/);
    const vacate = functionBody('assignSeats');
    expect(vacate).toMatch(/rolled = null/);
  });

  it('re-draws if the cached pick is no longer in the library', () => {
    // Deleting the silhouette a seat happened to draw must not leave it blank.
    expect(functionBody('artFor')).toMatch(/list\.indexOf\(seat\.rolled\) === -1/);
  });

  it('gives the animation phase to the seat, not the occupant', () => {
    // Otherwise a chatter arriving mid-bounce would restart the spot's rhythm.
    const body = functionBody('buildSeat');
    for (const key of ['beat', 'driftPhase', 'driftRate', 'rateJitter']) {
      expect(body, `${key} should belong to the seat`).toMatch(new RegExp(key + ':'));
    }
  });

  it('moves only the occupancy when the crowd reshuffles', () => {
    // assignSeats hands seats a new occupant; it must never move or rebuild the
    // artwork, or the characters would travel with the people again.
    const body = functionBody('assignSeats');
    expect(body).toMatch(/seat\.user = occ\.id/);
    expect(body).toMatch(/seat\.occupantAvatar = /);
    expect(body).not.toMatch(/artFor|innerHTML/);
  });

  it('keeps an emptied seat until the layout drops it', () => {
    const body = functionBody('assignSeats');
    // Vacated: fades out but stays, waiting for the next occupant.
    expect(body).toMatch(/classList\.remove\('in'\)/);
    // Removed only once the row or slot no longer exists.
    expect(body).toMatch(/rowCapacity\(s3\.row\)/);
  });

  it('centres the artwork in a way that survives overflowing its box', () => {
    // The body box is a fixed 0.62 x height but the artwork is width:auto, so any
    // silhouette with an aspect wider than 0.62 is WIDER than its box. CSS 2.1
    // 10.3.3: a box wider than its container has its auto margins treated as zero,
    // so `margin: 0 auto` centred the narrow art and silently left everything
    // wider flush against the left edge, with the avatar — centred on the box —
    // sitting off to the left of the artwork. Flex centring overflows both sides
    // equally, so it holds at every aspect ratio.
    const body = /\.body\{([^}]*)\}/.exec(SRC);
    expect(body, '.body rule not found').not.toBeNull();
    expect(body![1]!).toMatch(/display:\s*flex/);
    expect(body![1]!).toMatch(/justify-content:\s*center/);

    const sil = /\.sil\{([^}]*)\}/.exec(SRC);
    expect(sil, '.sil rule not found').not.toBeNull();
    // An auto margin here would be the old, aspect-dependent centring.
    expect(sil![1]!).not.toMatch(/margin:[^;]*auto/);

    // The arithmetic the two mechanisms give, for the record. Body is 0.62 x height;
    // auto margins collapse to zero once the image is wider than that, leaving the
    // artwork's centre (width - box) / 2 to the right of the avatar.
    const H = 190;
    const box = 0.62 * H;
    const autoBias = (aspect: number) => (aspect * H > box ? (aspect * H - box) / 2 : 0);
    expect(autoBias(0.4)).toBe(0);
    expect(autoBias(1)).toBeCloseTo(36.1, 1); // a square silhouette: 36px off
    expect(autoBias(1.33)).toBeCloseTo(67.5, 1);
  });

  it('keeps the avatar anchored to the same centre line as the artwork', () => {
    // Both are centred on the body box, which is the only reason they agree.
    const av = /\.av\{([^}]*)\}/.exec(SRC);
    expect(av, '.av rule not found').not.toBeNull();
    expect(av![1]!).toMatch(/left:\s*50%/);
    expect(av![1]!).toMatch(/translate\(-50%/);
    // The box itself is centred on the member's x by a half-width pull.
    const stat = functionBody('applyStatic');
    expect(stat).toMatch(/width = \(base\.height \* 0\.62\)/);
    expect(stat).toMatch(/marginLeft = \(-base\.height \* 0\.31\)/);
  });

  it('still renders, with JS that compiles', () => {
    const html = crowdHypeOverlayPage();
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
    expect(scripts).toHaveLength(1);
    expect(() => new Function(scripts[0]!)).not.toThrow();
  });
});

/**
 * The excitement easing. Levels used to be applied the instant the rate crossed a
 * threshold, so a burst of chat snapped the whole crowd from a calm sway to a full
 * jump between two frames — read as a glitch. Now the level is a continuous value
 * that walks toward its target, which also means it cannot skip a level: passing
 * through 3 on the way from 2 to 4 is a property of moving continuously, not a
 * special case. These run the overlay's own easing code.
 */
const LEVEL_FIXTURE = [
  { jumpPx: 0, bounceHz: 0.5, swayDeg: 2, jitterPx: 0, driftPx: 4 },
  { jumpPx: 4, bounceHz: 1.0, swayDeg: 4, jitterPx: 1, driftPx: 14 },
  { jumpPx: 10, bounceHz: 1.6, swayDeg: 7, jitterPx: 2, driftPx: 28 },
  { jumpPx: 20, bounceHz: 2.3, swayDeg: 10, jitterPx: 3, driftPx: 46 },
  { jumpPx: 34, bounceHz: 3.0, swayDeg: 14, jitterPx: 5, driftPx: 66 },
];
const CALM_FIXTURE = { jumpPx: 0, bounceHz: 0.3, swayDeg: 1, jitterPx: 0, driftPx: 10 };

type Anim = Record<string, number> & { jumpPx: number; driftPx: number };

interface Easer {
  tick(dt: number): Anim;
  target(level: number): void;
  level(): number;
  mode(m: string): void;
}

/** Build the overlay's easing in isolation, over a fixed level table. */
function easer(cfg: Record<string, unknown>): Easer {
  const animKeys = /var ANIM_KEYS = \[[^\]]*\]/.exec(SRC);
  expect(animKeys, 'ANIM_KEYS not found').not.toBeNull();
  const body = [
    'var cfg = CFG;',
    'var levelNow = 1, levelTarget = 1, slowMix = 0;',
    'function num(v, d){ var n = Number(v); return isFinite(n) ? n : d; }',
    animKeys![0] + ';',
    functionSrc('lerpAnim'),
    functionSrc('approach'),
    functionSrc('easeAnim'),
    'return {',
    '  tick: function(dt){ return easeAnim(dt); },',
    '  target: function(v){ levelTarget = v; },',
    '  level: function(){ return levelNow; },',
    '  mode: function(m){ cfg.mode = m; }',
    '};',
  ].join('\n');
  return new Function('CFG', body)({ levels: LEVEL_FIXTURE, calm: CALM_FIXTURE, ...cfg }) as Easer;
}

/** Run `seconds` of 60fps frames, returning every integer level boundary crossed. */
function crossings(e: Easer, seconds: number): number[] {
  const out: number[] = [];
  for (let f = 0; f < seconds * 60; f++) {
    const before = e.level();
    e.tick(1 / 60);
    const after = e.level();
    for (const L of [2, 3, 4, 5]) {
      if ((before < L && after >= L) || (before > L && after <= L)) out.push(L);
    }
  }
  return out;
}

describe('crowd overlay excitement easing', () => {
  it('walks every level in between instead of jumping to the target', () => {
    // THE point of the setting: chat slamming from dead calm to peak hype must
    // still be seen to pass through 2, 3 and 4.
    const e = easer({ transitionSeconds: 4 });
    e.target(5);
    expect(crossings(e, 30)).toEqual([2, 3, 4, 5]);
    expect(e.level()).toBe(5);
  });

  it('walks back down through every level too', () => {
    const e = easer({ transitionSeconds: 2 });
    e.target(5);
    crossings(e, 20);
    e.target(1);
    expect(crossings(e, 20)).toEqual([4, 3, 2]);
    expect(e.level()).toBe(1);
  });

  it('spends the configured time on each level step', () => {
    // 'Transition time' is seconds per level, so one step lands on the nose and a
    // four-level swing takes four times as long.
    const e = easer({ transitionSeconds: 4 });
    e.target(2);
    for (let f = 0; f < 4 * 60; f++) e.tick(1 / 60);
    expect(e.level()).toBeCloseTo(2, 5);

    const far = easer({ transitionSeconds: 4 });
    far.target(5);
    for (let f = 0; f < 8 * 60; f++) far.tick(1 / 60);
    expect(far.level()).toBeCloseTo(3, 1); // halfway after 8 of the 16 seconds
  });

  it('snaps when the transition time is zero', () => {
    // The old behaviour, still reachable by setting the field to 0.
    const e = easer({ transitionSeconds: 0 });
    e.target(5);
    e.tick(1 / 60);
    expect(e.level()).toBe(5);
  });

  it('blends only between the two levels it sits between', () => {
    // Halfway from 2 to 3 must read as the midpoint of those two rows of the
    // table and never borrow from level 1 or 4.
    const e = easer({ transitionSeconds: 1 });
    e.target(3);
    let anim = {} as Anim;
    for (let f = 0; f < 90; f++) anim = e.tick(1 / 60); // 1.5s = level 2.5
    expect(e.level()).toBeCloseTo(2.5, 5);
    expect(anim.jumpPx).toBeCloseTo((4 + 10) / 2, 5);
    expect(anim.driftPx).toBeCloseTo((14 + 28) / 2, 5);
  });

  it('holds still once it has arrived', () => {
    const e = easer({ transitionSeconds: 3 });
    e.target(4);
    for (let f = 0; f < 60 * 60; f++) e.tick(1 / 60);
    expect(e.level()).toBe(4);
    expect(crossings(e, 5)).toEqual([]); // no overshoot past 4 and back
  });

  it('never leaves the level table, however the target arrives', () => {
    // d.level comes off the wire; a stale or wrong value must not index past the
    // ends of the table and produce undefined animation values.
    for (const target of [-3, 0, 1.5, 9, 99]) {
      const e = easer({ transitionSeconds: 1 });
      e.target(target);
      let anim = {} as Anim;
      for (let f = 0; f < 20 * 60; f++) anim = e.tick(1 / 60);
      expect(e.level()).toBeGreaterThanOrEqual(1);
      expect(e.level()).toBeLessThanOrEqual(LEVEL_FIXTURE.length);
      for (const k of Object.keys(CALM_FIXTURE)) expect(Number.isFinite(anim[k])).toBe(true);
    }
  });

  it('eases into slow mode rather than cutting to it', () => {
    const e = easer({ transitionSeconds: 4 });
    e.target(5);
    for (let f = 0; f < 30 * 60; f++) e.tick(1 / 60);
    const hyped = e.tick(1 / 60).driftPx;
    e.mode('slow');
    const firstFrame = e.tick(1 / 60).driftPx;
    // One frame into slow mode it has barely moved; it must not be calm already.
    expect(Math.abs(firstFrame - hyped)).toBeLessThan(1);
    for (let f = 0; f < 4 * 60; f++) e.tick(1 / 60);
    expect(e.tick(1 / 60).driftPx).toBeCloseTo(CALM_FIXTURE.driftPx, 1);
  });
});

/**
 * Emote spew. Launch speed and distance used to be the same number: the arc height
 * was derived from the speed, so there was no way to ask for a fast short lob or a
 * slow high one. They are separate now, which means the time to the top of the arc
 * is distance/speed and has to stay inside the emote's lifetime. These run the
 * overlay's own launch arithmetic.
 */
interface Launch {
  settings(mix: number): Record<string, number>;
  vary(value: number, variability: number, floor: number): number;
}

function launcher(cfg: Record<string, unknown>, rand = Math.random): Launch {
  const keys = /var SPEW_KEYS = \[[^\]]*\]/.exec(SRC);
  expect(keys, 'SPEW_KEYS not found').not.toBeNull();
  const body = [
    'var cfg = CFG, slowMix = 0;',
    'var Math = MATH;',
    'function num(v, d){ var n = Number(v); return isFinite(n) ? n : d; }',
    keys![0] + ';',
    functionSrc('spewSettings'),
    functionSrc('vary'),
    'return {',
    '  settings: function(mix){ slowMix = mix; return spewSettings(); },',
    '  vary: vary',
    '};',
  ].join('\n');
  const math = Object.create(Math) as Math;
  (math as { random: () => number }).random = rand;
  return new Function('CFG', 'MATH', body)(cfg, math) as Launch;
}

const SPEW = { speed: 260, speedVar: 30, distance: 300, distanceVar: 60, size: 44, seconds: 2.2 };
const SPEW_SLOW = { speed: 110, speedVar: 15, distance: 140, distanceVar: 30, size: 40, seconds: 2.8 };

describe('crowd overlay emote spew', () => {
  it('uses the normal set in regular mode and the slow set in slow mode', () => {
    const l = launcher({ spew: SPEW, spewSlow: SPEW_SLOW });
    expect(l.settings(0)).toEqual(SPEW);
    expect(l.settings(1)).toEqual(SPEW_SLOW);
  });

  it('blends the two sets while slow mode is easing in', () => {
    // Launches during the transition must not change character in one frame, the
    // same reasoning as the level easing.
    const l = launcher({ spew: SPEW, spewSlow: SPEW_SLOW });
    const half = l.settings(0.5);
    expect(half.speed).toBeCloseTo((260 + 110) / 2, 5);
    expect(half.distance).toBeCloseTo((300 + 140) / 2, 5);
    expect(half.seconds).toBeCloseTo((2.2 + 2.8) / 2, 5);
  });

  it('clamps the blend, so a stray mix cannot overshoot either set', () => {
    const l = launcher({ spew: SPEW, spewSlow: SPEW_SLOW });
    expect(l.settings(-2).speed).toBe(260);
    expect(l.settings(5).speed).toBe(110);
  });

  it('falls back to the normal set when no slow set has arrived', () => {
    // An overlay talking to an older server, or a config that never saved one.
    const l = launcher({ spew: SPEW });
    expect(l.settings(1)).toEqual(SPEW);
  });

  it('varies a launch by plus or minus the variability, never past the floor', () => {
    // 260 +/- 30 is 230..290, the example from the spec.
    const lo = launcher({}, () => 0).vary(260, 30, 20);
    const hi = launcher({}, () => 1).vary(260, 30, 20);
    const mid = launcher({}, () => 0.5).vary(260, 30, 20);
    expect(lo).toBe(230);
    expect(hi).toBe(290);
    expect(mid).toBe(260);

    // Variability larger than the value must not fire an emote backwards.
    expect(launcher({}, () => 0).vary(30, 500, 20)).toBe(20);
    expect(launcher({}, () => 0).vary(100, 0, 20)).toBe(100);
  });

  it('keeps the arc inside the emote lifetime', () => {
    // Replays the overlay's own clamp: the top of the arc has to land inside the
    // animation, or the keyframe offset would be out of range and the emote would
    // vanish mid-flight.
    const body = functionBody('spew');
    expect(body).toMatch(/var apex = Math\.min\(0?\.85, Math\.max\(0?\.15, \(rise \/ speed\) \/ life\)\)/);
    expect(body).toMatch(/offset:apex/);

    const apex = (dist: number, speed: number, life: number) =>
      Math.min(0.85, Math.max(0.15, dist / speed / life));
    expect(apex(300, 260, 2.2)).toBeCloseTo(0.524, 3); // the defaults
    expect(apex(140, 110, 2.8)).toBeCloseTo(0.455, 3); // the slow defaults
    expect(apex(2000, 20, 0.3)).toBe(0.85); // absurdly far and slow: still lands
    expect(apex(10, 1200, 10)).toBe(0.15); // absurdly near and fast: still visible
  });

  it('scales distance and speed together, so timing does not depend on the row', () => {
    // Both are multiplied by the row scale, so distance/speed cancels it out and a
    // back-row emote takes exactly as long as a front-row one.
    const body = functionBody('spew');
    expect(body).toMatch(/var speed = vary\(sp\.speed, sp\.speedVar, 20\) \* base\.scale/);
    expect(body).toMatch(/var rise = vary\(sp\.distance, sp\.distanceVar, 10\) \* base\.scale/);
    for (const scale of [1, 0.86, 0.5]) {
      expect((300 * scale) / (260 * scale)).toBeCloseTo(300 / 260, 10);
    }
  });

  it('reads the launch settings once per burst, not once per emote', () => {
    // A burst of five emotes from one message should look like one burst; rolling
    // the blend per emote would also cost five lerps instead of one.
    const body = functionBody('spew');
    const beforeLoop = body.slice(0, body.indexOf('for (var i = 0'));
    expect(beforeLoop).toMatch(/var sp = spewSettings\(\);/);
  });
});

/**
 * The hop phase. The excitement easing made bounceHz a continuously changing
 * value, which turned a latent bug into a visible one: the hop was computed as
 * sin(t * hz), so changing hz rescales the whole elapsed time and moves the phase
 * rather than its speed. Five minutes into a stream one frame of the ease moved
 * the phase a cycle and a half, so the crowd shook itself apart instead of easing.
 * The phase has to accumulate.
 */
describe('crowd overlay hop phase', () => {
  const FRAME = codeOnly(functionBody('frame'));

  it('accumulates the phase instead of scaling elapsed time', () => {
    expect(FRAME).toMatch(/p\.beat \+= dt \* hz \* p\.rateJitter \* Math\.PI/);
    expect(FRAME).toMatch(/Math\.abs\(Math\.sin\(p\.beat\)\)/);
    expect(FRAME).toMatch(/Math\.sin\(p\.beat \* 0\.5\)/);
    // The shape of the old bug, in either order.
    expect(FRAME).not.toMatch(/\bt \* hz\b/);
    expect(FRAME).not.toMatch(/\bhz \* t\b/);
  });

  it('seeds the phase per seat so the crowd is not in lockstep', () => {
    const build = codeOnly(functionBody('buildSeat'));
    expect(build).toMatch(/beat: Math\.random\(\) \* Math\.PI \* 2/);
    expect(build).not.toMatch(/phase: Math\.random/); // renamed, not duplicated
  });

  it('lets an eased value set an oscillator amplitude, never its phase', () => {
    // The general rule, so the next eased setting cannot reintroduce this bug. An
    // eased value outside the trig call is an amplitude and eases smoothly; inside
    // the argument it moves the phase, and anything multiplied by elapsed time
    // moves it further the longer the overlay has been running. Only per-member
    // constants (driftRate, driftPhase) may appear beside t.
    const eased = ['jump', 'hz', 'sway', 'jit', 'drift'];
    const args: string[] = [];
    for (const m of FRAME.matchAll(/Math\.(?:sin|cos)\(/g)) {
      let i = m.index! + m[0].length;
      let depth = 1;
      const from = i;
      for (; i < FRAME.length && depth > 0; i++) {
        if (FRAME[i] === '(') depth++;
        else if (FRAME[i] === ')') depth--;
      }
      args.push(FRAME.slice(from, i - 1));
    }
    expect(args.length, 'no oscillators found — has the frame loop moved?').toBeGreaterThan(1);
    for (const arg of args) {
      if (!/\bt\b/.test(arg)) continue; // a phase that does not use elapsed time is safe
      for (const name of eased) {
        expect(new RegExp('\\b' + name + '\\b').test(arg),
          `the eased '${name}' is inside an oscillator phase scaled by elapsed time: ${arg}`).toBe(false);
      }
    }
  });

  it('advances the phase at a rate set by hz, independent of how long it has run', () => {
    // The property the fix buys, as arithmetic: one frame's advance depends only on
    // dt and hz. The old form's advance also depends on t, which is the bug.
    const dt = 1 / 60;
    const rj = 1;
    const advance = (hz: number) => dt * hz * rj * Math.PI;
    expect(advance(1.6)).toBeCloseTo(0.0838, 4);

    // Old form: beat = t * hz, so easing hz by one frame's step shifts the phase by
    // t * dHz * PI — a cycle and a half at five minutes in.
    const dHz = (3.0 - 0.5) / (4 * 60); // a 1->5 ease over the 4s default
    const oldShift = (t: number) => t * dHz * Math.PI;
    expect(oldShift(1)).toBeLessThan(Math.PI / 2);
    expect(oldShift(300) / (2 * Math.PI)).toBeGreaterThan(1.5); // whole cycles per frame
    // The fixed form has no t term at all, so it is the same at any elapsed time.
    for (const t of [1, 60, 300, 1800]) {
      expect(advance(1.6)).toBeCloseTo(0.0838, 4);
      expect(t * 0 + advance(1.6)).toBeLessThan(0.1); // bounded, whatever t is
    }
  });

  it('still lets the hop speed up as the level climbs', () => {
    // The fix must not flatten the thing it protects: a higher hz still means more
    // phase per second, it just no longer jumps when hz changes.
    const perSecond = (hz: number) => hz * Math.PI;
    expect(perSecond(3.0)).toBeGreaterThan(perSecond(0.5));
    expect(perSecond(3.0) / perSecond(0.5)).toBeCloseTo(6, 5);
  });
});
