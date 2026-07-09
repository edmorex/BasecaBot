import { describe, it, expect } from 'vitest';
import { parseTarget, normalizeWord, restrictKeywordToLevel } from './customCommands.js';
import { PermissionLevel } from '../core/events.js';

describe('parseTarget', () => {
  it('parses a trigger and the trailing message', () => {
    expect(parseTarget('!hello Hi there!')).toEqual({ target: { kind: 'trigger', name: 'hello' }, rest: 'Hi there!' });
  });

  it('normalizes trigger case and a leading @/!', () => {
    expect(parseTarget('!HELLO')).toEqual({ target: { kind: 'trigger', name: 'hello' }, rest: '' });
  });

  it('parses a quoted phrase and the trailing message', () => {
    expect(parseTarget('"good game" Well played')).toEqual({ target: { kind: 'phrase', name: 'good game' }, rest: 'Well played' });
  });

  it('returns null for a bare word or an unterminated quote', () => {
    expect(parseTarget('hello')).toBeNull();
    expect(parseTarget('"unterminated')).toBeNull();
    expect(parseTarget('')).toBeNull();
  });
});

describe('normalizeWord', () => {
  it('lowercases and strips a leading !', () => {
    expect(normalizeWord('!Hello')).toBe('hello');
    expect(normalizeWord('  YO ')).toBe('yo');
  });
});

describe('restrictKeywordToLevel', () => {
  it('maps keywords to permission levels', () => {
    expect(restrictKeywordToLevel('All')).toBe(PermissionLevel.Viewer);
    expect(restrictKeywordToLevel('sub')).toBe(PermissionLevel.Subscriber);
    expect(restrictKeywordToLevel('VIP')).toBe(PermissionLevel.Vip);
    expect(restrictKeywordToLevel('Mod')).toBe(PermissionLevel.Moderator);
    expect(restrictKeywordToLevel('broadcaster')).toBe(PermissionLevel.Broadcaster);
    expect(restrictKeywordToLevel('ADMIN')).toBe(PermissionLevel.Admin);
    expect(restrictKeywordToLevel('nope')).toBeNull();
  });
});
