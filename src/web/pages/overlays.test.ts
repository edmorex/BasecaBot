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
