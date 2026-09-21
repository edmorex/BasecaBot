import { describe, it, expect } from 'vitest';
import { readPngSize, safeImageName, FLOOF_VARIABLES, FLOOF_DEFAULTS } from './floof.js';

/** Build a minimal PNG header with the given dimensions. */
function pngHeader(width: number, height: number): Buffer {
  const buf = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write('IHDR', 12, 'ascii');
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

describe('readPngSize', () => {
  it('reads dimensions out of a PNG IHDR header', () => {
    expect(readPngSize(pngHeader(512, 512))).toEqual({ width: 512, height: 512 });
    expect(readPngSize(pngHeader(640, 480))).toEqual({ width: 640, height: 480 });
  });

  it('rejects non-PNG and truncated data', () => {
    expect(readPngSize(Buffer.from('not a png at all, just text here'))).toBeNull();
    expect(readPngSize(Buffer.alloc(10))).toBeNull(); // too short
    const badChunk = pngHeader(64, 64);
    badChunk.write('IDAT', 12, 'ascii'); // right signature, wrong first chunk
    expect(readPngSize(badChunk)).toBeNull();
  });
});

describe('safeImageName', () => {
  it('strips paths and forces a .png extension', () => {
    expect(safeImageName('mochi.png')).toBe('mochi.png');
    expect(safeImageName('Biscuit')).toBe('Biscuit.png');
    expect(safeImageName('../../etc/passwd')).toBe('passwd.png'); // no traversal
    expect(safeImageName('my cat!.png')).toBe('my_cat_.png'); // charset-scrubbed
  });

  it('never returns an empty or dot-leading name', () => {
    expect(safeImageName('')).toBe('floof.png');
    expect(safeImageName('...')).toBe('floof.png');
  });
});

describe('floof config surface', () => {
  it('maps every chat variable onto a real config key', () => {
    for (const key of Object.values(FLOOF_VARIABLES)) {
      expect(FLOOF_DEFAULTS).toHaveProperty(key);
    }
    // The documented defaults: 16 min base + up to 8 min extra.
    expect(FLOOF_DEFAULTS.baseSeconds).toBe(960);
    expect(FLOOF_DEFAULTS.randomSeconds).toBe(480);
    expect(FLOOF_DEFAULTS.enabled).toBe(false);
  });

  it('exposes the padding setters chat users need', () => {
    expect(Object.keys(FLOOF_VARIABLES)).toEqual(
      expect.arrayContaining(['enabled', 'base', 'random', 'despawn', 'speed', 'pad-left', 'pad-right', 'pad-top', 'pad-bottom']),
    );
  });
});
