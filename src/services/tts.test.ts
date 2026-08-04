import { describe, it, expect, vi } from 'vitest';
import { TtsService, VOICE_DEFAULTS } from './tts.js';
import type { Storage } from './storage/index.js';
import type { AppConfig } from './config.js';
import type { Logger } from './logger.js';
import type { WsHub } from '../web/wsHub.js';

/** Build a TtsService over in-memory fakes. `model` undefined = not configured. */
function make(model?: string) {
  const settings = new Map<string, string>();
  const storage = {
    prisma: {
      setting: {
        findMany: async () => [...settings.entries()].map(([key, value]) => ({ key, value })),
        upsert: async ({ where, create }: { where: { key: string }; create: { key: string; value: string } }) => {
          settings.set(where.key, create.value);
          return create;
        },
      },
    },
  } as unknown as Storage;
  const broadcast = vi.fn();
  const ws = { broadcast } as unknown as WsHub;
  const config = { tts: { piperBin: 'piper', model } } as unknown as AppConfig;
  const noop = () => {};
  const logger = { info: noop, warn: noop, error: noop, debug: noop, child: () => logger } as unknown as Logger;
  return { tts: new TtsService(storage, ws, config, logger), broadcast, settings };
}

describe('TtsService.speak guards (no synthesis)', () => {
  it('is a no-op when not configured', async () => {
    const { tts, broadcast } = make(undefined);
    expect(tts.configured).toBe(false);
    expect(await tts.speak('hello')).toEqual({ ok: false, reason: 'unconfigured' });
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('does not speak when muted', async () => {
    const { tts, broadcast } = make('/nope/model.onnx');
    await tts.setMuted(true);
    expect(tts.isMuted()).toBe(true);
    expect(await tts.speak('hello')).toEqual({ ok: false, reason: 'muted' });
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('rejects empty and over-long text', async () => {
    const { tts } = make('/nope/model.onnx');
    expect(await tts.speak('   ')).toEqual({ ok: false, reason: 'empty' });
    expect(await tts.speak('x'.repeat(501))).toEqual({ ok: false, reason: 'too-long' });
  });
});

describe('TtsService voice settings', () => {
  it('clamps out-of-range knobs and persists them', async () => {
    const { tts, settings } = make('/nope/model.onnx');
    const v = await tts.setVoice({ lengthScale: 99, volume: -5, noiseScale: 0.5 });
    expect(v.lengthScale).toBe(2); // clamped to max
    expect(v.volume).toBe(0); // clamped to min
    expect(v.noiseScale).toBe(0.5); // in range, kept
    expect(JSON.parse(settings.get('tts.voice')!).lengthScale).toBe(2);
  });

  it('reloads persisted mute + voice on init', async () => {
    const { tts, settings } = make('/nope/model.onnx');
    settings.set('tts.muted', 'true');
    settings.set('tts.voice', JSON.stringify({ ...VOICE_DEFAULTS, noiseW: 0.25 }));
    await tts.init();
    expect(tts.isMuted()).toBe(true);
    expect(tts.getVoice().noiseW).toBe(0.25);
  });

  it('hides the speaker list for single-speaker models', async () => {
    const { tts } = make('/nope/model.onnx');
    await tts.init(); // no sidecar json -> single speaker
    expect(tts.getSpeakers()).toEqual({ numSpeakers: 1, speakers: [] });
  });
});
