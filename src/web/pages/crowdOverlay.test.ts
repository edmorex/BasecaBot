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
    // rowScale,rows,row; filter <- glow; avatar <- avatarSize,rowScale,rows,row.
    expect(DEPS.sort()).toEqual(['avatarSize', 'glow', 'row', 'rowScale', 'rows', 'silhouetteHeight']);
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
    const unguarded = body.slice(body.indexOf('for (var id in people)'), guard);
    const writes = [...unguarded.matchAll(/\.style\.(\w+)\s*=/g)].map((m) => m[1]!);
    expect([...new Set(writes)].sort()).toEqual(['transform']);
  });

  it('applies the guarded styles on a member’s very first frame', () => {
    // An empty starting signature can never equal a real one, so the first
    // comparison always fails and the statics land immediately.
    expect(SRC).toMatch(/sig: ''/);
  });

  it('re-applies them when the avatar node is rebuilt', () => {
    // paint() can replace the avatar element; the new one has no sizing yet, so
    // the signature has to be invalidated or it stays at its default size.
    const body = functionBody('paint');
    expect(body).toMatch(/p\.sig = ''/);
  });

  it('keeps the constant colour out of the frame loop entirely', () => {
    expect(functionBody('frame')).not.toMatch(/style\.color/);
    expect(SRC).toMatch(/\.body\{[^}]*color:rgba\(8,6,12,\.96\)/);
  });

  it('still renders, with JS that compiles', () => {
    const html = crowdHypeOverlayPage();
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
    expect(scripts).toHaveLength(1);
    expect(() => new Function(scripts[0]!)).not.toThrow();
  });
});
