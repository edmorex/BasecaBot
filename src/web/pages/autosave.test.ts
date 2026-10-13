import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { FLOOF_DEFAULTS } from '../../services/floof.js';
import { BOSS_DEFAULTS } from '../../services/bossBattle.js';
import { CROWD_DEFAULTS } from '../../services/crowdHype.js';

/**
 * The Pet the Floof and Boss Battle panels save themselves as they are edited, so
 * there is no button whose absence would reveal an unwired field: a setting the
 * panel forgets to watch simply never persists, silently. These checks pin the
 * wiring to the services' own config shapes.
 */
const ADMIN = readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), 'admin.ts'), 'utf8');

/** The `key:` values of a field-spec array in the admin script. */
function fieldKeys(arrayName: string): string[] {
  const start = ADMIN.indexOf('var ' + arrayName + ' = [');
  expect(start, `${arrayName} not found`).toBeGreaterThan(-1);
  let depth = 0;
  const open = ADMIN.indexOf('[', start);
  let end = open;
  for (; end < ADMIN.length; end++) {
    if (ADMIN[end] === '[') depth++;
    else if (ADMIN[end] === ']' && --depth === 0) break;
  }
  return [...ADMIN.slice(open, end).matchAll(/key: '(\w+)'/g)].map((m) => m[1]!);
}

const floofWatched = new Set([
  'enabled',
  ...fieldKeys('FLOOF_TIMING'),
  ...fieldKeys('FLOOF_PAD'),
  ...fieldKeys('FLOOF_ANIM'),
]);
const bossWatched = new Set([
  'enabled', 'cooldownSeconds', 'startDelaySeconds', 'volumeSfx', 'volumeBgm',
  ...fieldKeys('BOSS_ANIM'),
  ...fieldKeys('BOSS_CANNON'),
]);

/**
 * The Crowd Hype panel collects its settings by hand rather than from one field
 * table, so a setting added to the service can be left without a control: it
 * keeps its default forever and nothing reports a problem. This derives the
 * requirement from CROWD_DEFAULTS.
 */
const CROWD_COLLECT = (() => {
  const from = ADMIN.indexOf('injectCrowdCss();');
  const to = ADMIN.indexOf("autoSaver('/api/admin/crowd'");
  expect(from, 'crowd collect() not found').toBeGreaterThan(-1);
  expect(to).toBeGreaterThan(from);
  return ADMIN.slice(from, to);
})();

const crowdCollected = new Set([
  ...[...CROWD_COLLECT.matchAll(/out\.(\w+)\s*=/g)].map((m) => m[1]!),
  ...[...CROWD_COLLECT.matchAll(/(\w+):\s*document\.getElementById/g)].map((m) => m[1]!),
  ...fieldKeys('CROWD_LAYOUT'),
  ...fieldKeys('CROWD_SPEW'),
  // The slow-mode group is derived from the normal one rather than written out,
  // so mirror that here — and the test below pins the derivation itself.
  ...fieldKeys('CROWD_SPEW').map((k) => k.replace('spew', 'spewSlow')),
  ...fieldKeys('CROWD_LIGHTER_LOOK'),
  ...fieldKeys('CROWD_LIGHTER'),
  ...fieldKeys('CROWD_SIM'),
  'rateWindowSeconds', // the lone key appended to the flat list inline
]);

describe('admin panel autosave', () => {
  it('watches every Pet the Floof setting the service defines', () => {
    const missing = Object.keys(FLOOF_DEFAULTS).filter((k) => !floofWatched.has(k));
    expect(missing, `these would never save: ${missing.join(', ')}`).toEqual([]);
  });

  it('watches every Boss Battle setting the service defines', () => {
    const missing = Object.keys(BOSS_DEFAULTS).filter((k) => !bossWatched.has(k));
    expect(missing, `these would never save: ${missing.join(', ')}`).toEqual([]);
  });

  it('does not invent settings the services would reject', () => {
    for (const [label, watched, defaults] of [
      ['floof', floofWatched, FLOOF_DEFAULTS],
      ['boss', bossWatched, BOSS_DEFAULTS],
    ] as const) {
      const extra = [...watched].filter((k) => !(k in defaults));
      expect(extra, `${label} sends unknown keys: ${extra.join(', ')}`).toEqual([]);
    }
  });

  it('leaves the spawn pickers out, so choosing what to spawn is not a settings change', () => {
    // These live in the same panels but are arguments to a button, not config.
    // Build the element ids the panels actually register, the same way they do.
    const watchedElementIds = [
      'floof-enabled',
      ...[...floofWatched].filter((k) => k !== 'enabled').map((k) => 'fl-' + k),
      'boss-enabled', 'boss-delay', 'boss-cooldownSeconds', 'boss-volumeSfx', 'boss-volumeBgm',
      ...[...bossWatched].filter((k) => k !== 'enabled').map((k) => 'boss-' + k),
    ];
    for (const id of ['fl-pick-image', 'fl-pick-style', 'boss-pick']) {
      expect(watchedElementIds, `${id} must not autosave`).not.toContain(id);
    }
    // ...and the action buttons are not settings either.
    for (const id of ['floof-fire', 'floof-sim', 'boss-start', 'boss-cancel', 'boss-new']) {
      expect(watchedElementIds, `${id} must not autosave`).not.toContain(id);
    }
    // Sanity: the list really is the panels' controls, not an empty array.
    expect(watchedElementIds).toContain('fl-baseSeconds');
    expect(watchedElementIds).toContain('boss-cannonRate');
  });

  it('debounces, and serialises saves so they cannot land out of order', () => {
    const i = ADMIN.indexOf('function autoSaver');
    expect(i).toBeGreaterThan(-1);
    const fn = ADMIN.slice(i, ADMIN.indexOf('\n    // ── Pet the Floof', i));
    // One request per burst of typing or slider dragging.
    expect(fn).toMatch(/setTimeout\(flush, immediate \? 0 : \d+\)/);
    // An edit during a save is held and re-sent afterwards, rather than racing it.
    expect(fn).toContain('if (inFlight) { again = true; return; }');
    expect(fn).toContain('if (again) { again = false; flush(); }');
    // A failed save has to stay on screen; there is no button left to retry with.
    expect(fn).toContain("state('failed'");
  });

  it('replaced both Save buttons rather than leaving them alongside', () => {
    expect(ADMIN).not.toContain('floof-save');
    expect(ADMIN).not.toContain('boss-save');
    expect(ADMIN).toContain('id="floof-status"');
    expect(ADMIN).toContain('id="boss-status"');
  });

  it('reports in the same place on both panels', () => {
    // Beside the panel heading, not buried among whichever buttons that panel has.
    for (const [title, id] of [['Pet the Floof', 'floof-status'], ['Boss Battle', 'boss-status']]) {
      const head = `<div class="panel-head"><h2>${title}</h2>' +\n        '<span class="save-state" id="${id}">`;
      expect(ADMIN, `${title} status is not in its heading`).toContain(head);
    }
    // Exactly one of each, so the old locations really are gone.
    expect(ADMIN.split('id="floof-status"').length - 1).toBe(1);
    expect(ADMIN.split('id="boss-status"').length - 1).toBe(1);
  });

  it('keeps the boss editor on an explicit save, since it creates a record', () => {
    // Autosaving a half-filled NEW boss would put it in the roster mid-edit.
    expect(ADMIN).toContain("id=\"be-save\"");
    expect(ADMIN).toContain('/api/admin/boss/save');
  });

  it('derives the slow-mode spew group from the normal one', () => {
    // If this derivation changes, the key list above stops matching the panel and
    // the coverage check below would be verifying the wrong names.
    expect(ADMIN).toMatch(/CROWD_SPEW_SLOW = CROWD_SPEW\.map/);
    expect(ADMIN).toMatch(/f\.key\.replace\('spew', 'spewSlow'\)/);
  });

  it('collects the non-numeric Crowd Hype settings as strings', () => {
    // Colours, dropdowns and the lighter glyph all go through one collector. Miss a
    // kind and Number('🔥') is NaN, which the service then throws away for the
    // default — a setting that silently refuses to change.
    expect(CROWD_COLLECT).toMatch(/\(f\.color \|\| f\.options \|\| f\.text\) \? String\(el\.value\) : Number\(el\.value\)/);
    // And the panel really does declare one of each kind, or the line above is
    // moot. (The mirror dropdown is hand-rolled markup and collected on its own
    // line, so it does not go through this collector at all.)
    expect(ADMIN).toMatch(/key: 'lighterGlyph'[^}]*text: true/);
    expect(ADMIN).toMatch(/key: 'lighterGlowColor'[^}]*color: true/);
    expect(CROWD_COLLECT).toMatch(/out\.mirrorMode = String\(/);
  });

  it('collects every Crowd Hype setting the service defines', () => {
    const missing = Object.keys(CROWD_DEFAULTS).filter((k) => !crowdCollected.has(k));
    expect(missing, `these would never save: ${missing.join(', ')}`).toEqual([]);
  });

  it('watches every Crowd Hype control it collects by id', () => {
    // A field can be collected and still not autosave if its id is missing from
    // the watch list — then it only persists when some other field changes.
    const ids = (() => {
      const m = /var ids = \[([\s\S]*?)\];/.exec(CROWD_COLLECT);
      expect(m, 'crowd autosave id list not found').not.toBeNull();
      return m![1]!;
    })();
    const read = [...CROWD_COLLECT.matchAll(/getElementById\('(cr-[\w-]+)'\)/g)].map((m) => m[1]!);
    const unwatched = [...new Set(read)].filter((id) => !ids.includes("'" + id + "'"));
    expect(unwatched, `edits to these would not save: ${unwatched.join(', ')}`).toEqual([]);
  });
});
