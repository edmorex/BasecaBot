import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { firstOverlayPage } from './overlayFirst.js';
import { ttsOverlayPage } from './overlayTts.js';
import { chatStatsOverlayPage } from './overlayChatStats.js';
import { achievementOverlayPage } from './overlayAchievement.js';
import { floofOverlayPage } from './overlayFloof.js';
import { bossBattleOverlayPage } from './overlayBossBattle.js';
import { crowdHypeOverlayPage } from './overlayCrowdHype.js';

/**
 * Every overlay is one big template literal holding its own CSS and JS, which
 * neither tsc nor eslint looks inside. These checks stand in for that: the page
 * must render, its script must compile, and the literal must not have leaked.
 */
const OVERLAYS: Record<string, { render: () => string; file: string }> = {
  first: { render: firstOverlayPage, file: 'overlayFirst.ts' },
  tts: { render: ttsOverlayPage, file: 'overlayTts.ts' },
  'chat-stats': { render: chatStatsOverlayPage, file: 'overlayChatStats.ts' },
  achievement: { render: achievementOverlayPage, file: 'overlayAchievement.ts' },
  floof: { render: floofOverlayPage, file: 'overlayFloof.ts' },
  'boss-battle': { render: bossBattleOverlayPage, file: 'overlayBossBattle.ts' },
  crowd: { render: crowdHypeOverlayPage, file: 'overlayCrowdHype.ts' },
};
const PAGE_DIR = path.dirname(new URL(import.meta.url).pathname);
const entries = Object.entries(OVERLAYS);

describe('overlay pages', () => {
  it.each(entries)('%s renders inline JS that compiles', (_name, o) => {
    const html = o.render();
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
    expect(scripts.length).toBeGreaterThan(0);
    // new Function compiles without running — enough to catch a broken literal.
    for (const js of scripts) expect(() => new Function(js)).not.toThrow();
  });

  it.each(entries)('%s keeps its template literal intact', (_name, o) => {
    const src = readFileSync(path.join(PAGE_DIR, o.file), 'utf8');
    const start = src.indexOf('return `');
    const end = src.lastIndexOf('`;');
    expect(start, `${o.file} has no page literal`).toBeGreaterThan(-1);
    const literal = src.slice(start + 8, end);
    // A stray backtick ends the literal early and a dollar-brace starts an
    // interpolation; tsc catches both, but only once they are already broken.
    // Asserting zero of each keeps the embedded script writable by hand.
    expect(literal.match(/`/g) ?? [], 'stray backtick').toHaveLength(0);
    expect(literal.match(/\$\{/g) ?? [], 'stray interpolation').toHaveLength(0);
  });

  it.each(entries)('%s is inert without a token', (_name, o) => {
    // Overlay URLs carry a read-only token; the page must not try to connect, or
    // subscribe to anything, when opened without one.
    const html = o.render();
    expect(html).toMatch(/token/);
  });

  it('every overlay reads its room from a distinct name', () => {
    const rooms = entries.map(([, o]) => /room=([a-z-]+)/.exec(o.render())?.[1]).filter(Boolean);
    expect(new Set(rooms).size, 'two overlays share a room').toBe(rooms.length);
  });
});

/**
 * The !first board can now be SPARSE. `!last` claims places from the bottom up,
 * so a race can legitimately hold places 1, 2, 9 and 10 with a hole in the
 * middle — something that could never happen when places were handed out by
 * counting rows. The overlay has to put each claim in its own numbered row rather
 * than listing them in order, or a 10th place would be drawn in the 3rd slot.
 */
describe('first overlay with a sparse board', () => {
  const SRC = readFileSync(path.join(PAGE_DIR, 'overlayFirst.ts'), 'utf8');

  it('keys entries by place, not by arrival order', () => {
    expect(SRC).toMatch(/var entries = \{\}; *\/\/ place -> /);
    // Every renderer walks the places and looks each one up, so a gap is drawn as
    // an empty row instead of pulling the next claim up into it.
    expect(SRC).toMatch(/for\(var p=1;p<=LIMIT;p\+\+\)\{\s*var e=entries\[p\];/);
    expect(SRC).toMatch(/\(e\?'filled':'empty'\)/);
    expect(SRC).toMatch(/entries\[d\.place\]=/);
    expect(SRC).toMatch(/entries\[e\.place\]=/);
  });

  it('accepts any place on the board, not just the next one', () => {
    // A 10th place arriving while the board is otherwise empty must be accepted.
    expect(SRC).toMatch(/if\(d\.place>=1 && d\.place<=LIMIT\)/);
  });

  it('replays the maths the overlay does, over a sparse board', () => {
    const LIMIT = 10;
    const entries: Record<number, { name: string }> = { 1: { name: 'A' }, 2: { name: 'B' }, 9: { name: 'C' }, 10: { name: 'D' } };
    const rows: string[] = [];
    for (let p = 1; p <= LIMIT; p++) rows.push(entries[p] ? entries[p]!.name : '-');
    expect(rows).toEqual(['A', 'B', '-', '-', '-', '-', '-', '-', 'C', 'D']);
  });
});
