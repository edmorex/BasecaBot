import { describe, it, expect } from 'vitest';
import { toCsv, parseCsv, mapCsvRows, QUOTE_CSV_SPEC, COMMAND_CSV_SPEC } from './csv.js';

describe('csv', () => {
  it('serializes, quoting only when needed', () => {
    expect(toCsv([['a', 'b', 'c']])).toBe('a,b,c');
    expect(toCsv([['has,comma', 'has"quote', 'has\nnewline']])).toBe('"has,comma","has""quote","has\nnewline"');
    expect(toCsv([[1, null, undefined]])).toBe('1,,');
    expect(toCsv([['a'], ['b']])).toBe('a\r\nb');
  });

  it('parses simple + quoted fields', () => {
    expect(parseCsv('a,b,c')).toEqual([['a', 'b', 'c']]);
    expect(parseCsv('"has,comma","has""quote"')).toEqual([['has,comma', 'has"quote']]);
    expect(parseCsv('"multi\nline",x')).toEqual([['multi\nline', 'x']]);
  });

  it('handles \\n, \\r\\n, and trailing newlines; drops blank lines', () => {
    expect(parseCsv('a,b\r\nc,d\n')).toEqual([['a', 'b'], ['c', 'd']]);
    expect(parseCsv('a\n\nb')).toEqual([['a'], ['b']]);
  });

  it('strips a BOM', () => {
    expect(parseCsv('﻿a,b')).toEqual([['a', 'b']]);
  });

  it('mapCsvRows maps by header (any column order), dropping the header row', () => {
    const rows = parseCsv('ID,Quote,User,Game,Date,Quoted By,Quoted By ID,Created At\n1,hi there,baseca,Elden Ring,2024-01-02,Mod,u9,2024-01-02T00:00:00.000Z');
    expect(mapCsvRows(rows, QUOTE_CSV_SPEC)).toEqual([
      { id: '1', text: 'hi there', user: 'baseca', game: 'Elden Ring', date: '2024-01-02', quotedByName: 'Mod', quotedById: 'u9', createdAt: '2024-01-02T00:00:00.000Z' },
    ]);
    // Header without some columns still maps the rest correctly by name.
    const noId = parseCsv('Quote,User\nhello,alice');
    expect(mapCsvRows(noId, QUOTE_CSV_SPEC)).toEqual([{ id: '', text: 'hello', user: 'alice', game: '', date: '', quotedByName: '', quotedById: '', createdAt: '' }]);
  });

  it('mapCsvRows falls back to positional order when there is no header', () => {
    const rows = parseCsv('1,hi,baseca,Game,2024-01-02,Mod'); // no header line
    expect(mapCsvRows(rows, QUOTE_CSV_SPEC)[0]).toMatchObject({ text: 'hi', user: 'baseca' });
  });

  it('maps a command CSV row (alias with target + args)', () => {
    const rows = parseCsv('Type,Name,Response,Group,Access,Enabled,Global Cooldown,User Cooldown,Uses,Target,Args,Created At,Updated At\nalias,d6,,Fun,Everyone,false,0,0,8,roll,$(random 1-6),,');
    expect(mapCsvRows(rows, COMMAND_CSV_SPEC)).toEqual([
      { type: 'alias', name: 'd6', response: '', group: 'Fun', access: 'Everyone', enabled: 'false', globalCooldown: '0', userCooldown: '0', usageCount: '8', target: 'roll', args: '$(random 1-6)', createdAt: '', updatedAt: '' },
    ]);
  });

  it('round-trips messy data', () => {
    const rows = [
      ['ID', 'Quote', 'User'],
      ['1', 'He said, "hi"', 'baseca'],
      ['2', 'line1\nline2', 'alice'],
      ['3', 'plain', 'bob'],
    ];
    expect(parseCsv(toCsv(rows))).toEqual(rows);
  });
});
