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
    for (const key of ['phase', 'driftPhase', 'driftRate', 'rateJitter']) {
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

  it('centres the artwork in its box, so the avatar lines up with it', () => {
    // The body box is a fixed 0.62 x height but the artwork is width:auto, so its
    // real width comes from the PNG's aspect ratio. Flush-left artwork put the
    // avatar off to one side — the direction depending on whether the image was
    // narrower or wider than the box.
    const m = /\.sil\{([^}]*)\}/.exec(SRC);
    expect(m, '.sil rule not found').not.toBeNull();
    expect(m![1]!).toMatch(/margin:\s*0 auto/);
  });

  it('still renders, with JS that compiles', () => {
    const html = crowdHypeOverlayPage();
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
    expect(scripts).toHaveLength(1);
    expect(() => new Function(scripts[0]!)).not.toThrow();
  });
});
