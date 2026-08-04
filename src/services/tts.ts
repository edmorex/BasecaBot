import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readFile, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Storage } from './storage/index.js';
import type { AppConfig } from './config.js';
import type { Logger } from './logger.js';
import type { WsHub } from '../web/wsHub.js';

/** Tunable voice parameters. The first four map to Piper CLI flags; `speaker`
 * selects a voice on multi-speaker models; `volume` (0..1) is a client-side gain
 * applied by the overlay (Piper has no gain option). */
export interface VoiceParams {
  /** `--length_scale` — speaking rate. Higher = SLOWER. */
  lengthScale: number;
  /** `--noise_scale` — pitch/intonation variability (expressiveness). */
  noiseScale: number;
  /** `--noise_w` — variation in phoneme durations (cadence). */
  noiseW: number;
  /** `--sentence_silence` — seconds of silence after each sentence. */
  sentenceSilence: number;
  /** `--speaker` — speaker id (0 for single-speaker models). */
  speaker: number;
  /** Playback volume 0..1, applied on the overlay `<audio>` element. */
  volume: number;
}

export const VOICE_DEFAULTS: VoiceParams = {
  lengthScale: 1,
  noiseScale: 0.667,
  noiseW: 0.8,
  sentenceSilence: 0.2,
  speaker: 0,
  volume: 1,
};

/** [min, max] slider bounds for each numeric knob (speaker is bounded by the model). */
export const VOICE_RANGES = {
  lengthScale: [0.5, 2],
  noiseScale: [0, 1],
  noiseW: [0, 1],
  sentenceSilence: [0, 1],
  volume: [0, 1],
} as const;

/** Why a speak() call produced no audio (never thrown — callers decide). */
export type SpeakReason = 'empty' | 'too-long' | 'unconfigured' | 'muted' | 'synth-failed';
export interface SpeakResult {
  ok: boolean;
  id?: string;
  reason?: SpeakReason;
}

const MAX_CHARS = 500;
const CACHE_MAX = 20;

/**
 * Text-to-Speech via Piper (offline neural TTS). Any plugin/overlay can call
 * `speak(text)`; the service synthesizes a wav on the server (spawning the piper
 * binary), caches it in memory keyed by the text + voice params, and broadcasts a
 * `speak` message on the WS hub's `tts` room. The dedicated TTS overlay fetches
 * the wav same-origin (`getAudio`) and plays it.
 *
 * Disabled ("not configured") until PIPER_MODEL is set — speak() is then a safe
 * no-op. A global mute (persisted) also short-circuits speak(). Voice params and
 * the mute flag live in the `Setting` key/value table.
 */
export class TtsService {
  private muted = false;
  private voice: VoiceParams = { ...VOICE_DEFAULTS };
  private numSpeakers = 1;
  private speakerNames: string[] = []; // id -> name, for multi-speaker models
  /** id -> wav bytes; insertion-ordered LRU (re-inserted on hit), capped at CACHE_MAX. */
  private readonly cache = new Map<string, Buffer>();

  constructor(
    private readonly storage: Storage,
    private readonly ws: WsHub,
    private readonly config: AppConfig,
    private readonly logger: Logger,
  ) {}

  private get db() {
    return this.storage.prisma;
  }

  /** TTS is usable iff a voice model is configured. */
  get configured(): boolean {
    return !!this.config.tts.model;
  }

  get defaults(): VoiceParams {
    return { ...VOICE_DEFAULTS };
  }

  /** Load persisted mute + voice settings and the model's speaker list. */
  async init(): Promise<void> {
    try {
      const rows = await this.db.setting.findMany({ where: { key: { in: ['tts.muted', 'tts.voice'] } } });
      for (const r of rows) {
        if (r.key === 'tts.muted') this.muted = r.value === 'true';
        else if (r.key === 'tts.voice') this.voice = this.clampVoice({ ...VOICE_DEFAULTS, ...safeJson(r.value) });
      }
    } catch (err) {
      this.logger.warn({ err }, 'tts: could not load settings');
    }
    this.loadSpeakers();
  }

  /** Read `<model>.onnx.json` for the speaker count/names (multi-speaker voices). */
  private loadSpeakers(): void {
    const model = this.config.tts.model;
    if (!model) return;
    try {
      const json = JSON.parse(readFileSync(model + '.json', 'utf8')) as {
        num_speakers?: number;
        speaker_id_map?: Record<string, number>;
      };
      this.numSpeakers = Number(json.num_speakers) || 1;
      if (json.speaker_id_map && this.numSpeakers > 1) {
        const names: string[] = [];
        for (const [name, id] of Object.entries(json.speaker_id_map)) names[id] = name;
        this.speakerNames = names;
      }
      // Re-clamp the persisted speaker id against the now-known speaker count.
      this.voice = this.clampVoice(this.voice);
    } catch {
      // No sidecar json / single-speaker voice — leave numSpeakers = 1.
    }
  }

  isMuted(): boolean {
    return this.muted;
  }

  async setMuted(muted: boolean): Promise<void> {
    this.muted = muted;
    await this.saveSetting('tts.muted', muted ? 'true' : 'false');
  }

  getVoice(): VoiceParams {
    return { ...this.voice };
  }

  /** `{ numSpeakers, speakers }` — `speakers` is empty for single-speaker models. */
  getSpeakers(): { numSpeakers: number; speakers: { id: number; name: string }[] } {
    const speakers =
      this.numSpeakers > 1
        ? Array.from({ length: this.numSpeakers }, (_, i) => ({ id: i, name: this.speakerNames[i] || `Speaker ${i}` }))
        : [];
    return { numSpeakers: this.numSpeakers, speakers };
  }

  /** Merge + clamp a partial voice update, persist it, and return the new voice. */
  async setVoice(partial: Partial<VoiceParams>): Promise<VoiceParams> {
    this.voice = this.clampVoice({ ...this.voice, ...partial });
    await this.saveSetting('tts.voice', JSON.stringify(this.voice));
    return this.getVoice();
  }

  /** Look up cached wav bytes for an id (and bump it to most-recently-used). */
  getAudio(id: string): Buffer | undefined {
    const buf = this.cache.get(id);
    if (buf) {
      this.cache.delete(id);
      this.cache.set(id, buf);
    }
    return buf;
  }

  /**
   * Synthesize + broadcast a line. Never throws: returns `{ ok:false, reason }`
   * when it can't speak (empty/too long/unconfigured/muted/synth failure) so a
   * plugin firing TTS on an event can't crash. The admin test route maps a
   * non-ok result to a friendly error.
   */
  async speak(text: string, opts?: { source?: string }): Promise<SpeakResult> {
    if (this.muted) return { ok: false, reason: 'muted' };
    const prep = await this.prepareClip(text);
    if (!prep.ok) return prep;
    this.ws.broadcast('tts', 'speak', { id: prep.id, text: prep.clean, volume: this.getVoice().volume });
    this.logger.info({ id: prep.id, source: opts?.source ?? 'plugin', chars: prep.clean.length }, 'tts: spoke');
    return { ok: true, id: prep.id };
  }

  /**
   * Render a clip and return its wav bytes for a LOCAL preview (the admin "Test
   * Voice" button plays it on the dashboard). Ignores mute and never broadcasts
   * to the overlay — it's purely a synthesis preview for tuning the voice.
   */
  async preview(text: string): Promise<{ ok: true; id: string; wav: Buffer } | { ok: false; reason: SpeakReason }> {
    const prep = await this.prepareClip(text);
    if (!prep.ok) return prep;
    return { ok: true, id: prep.id, wav: this.getAudio(prep.id)! };
  }

  /**
   * Shared core of speak()/preview(): validate + synthesize (or reuse a cached
   * clip) for `text` with the current voice. Does NOT check mute and does NOT
   * broadcast. Volume is applied at playback, so it's excluded from the cache key.
   */
  private async prepareClip(
    text: string,
  ): Promise<{ ok: true; id: string; clean: string } | { ok: false; reason: SpeakReason }> {
    const clean = String(text ?? '').trim();
    if (!clean) return { ok: false, reason: 'empty' };
    if (clean.length > MAX_CHARS) return { ok: false, reason: 'too-long' };
    if (!this.configured) return { ok: false, reason: 'unconfigured' };

    const voice = this.getVoice();
    const id = createHash('sha1')
      .update(JSON.stringify({ t: clean, v: { ...voice, volume: undefined } }))
      .digest('hex');

    if (this.getAudio(id) === undefined) {
      try {
        this.store(id, await this.synthesize(clean, voice));
      } catch (err) {
        this.logger.error({ err }, 'tts: piper synthesis failed');
        return { ok: false, reason: 'synth-failed' };
      }
    }
    return { ok: true, id, clean };
  }

  /** Run piper: text on stdin, wav to a temp file, returned as a Buffer. */
  private async synthesize(text: string, voice: VoiceParams): Promise<Buffer> {
    const model = this.config.tts.model!;
    const tmp = path.join(os.tmpdir(), `basecabot-tts-${randomUUID()}.wav`);
    const args = [
      '--model', model,
      '--length_scale', String(voice.lengthScale),
      '--noise_scale', String(voice.noiseScale),
      '--noise_w', String(voice.noiseW),
      '--sentence_silence', String(voice.sentenceSilence),
      '--output_file', tmp,
    ];
    if (voice.speaker > 0) args.push('--speaker', String(voice.speaker));

    await new Promise<void>((resolve, reject) => {
      const proc = spawn(this.config.tts.piperBin, args, { stdio: ['pipe', 'ignore', 'pipe'] });
      let stderr = '';
      proc.stderr.on('data', (d) => (stderr += d.toString()));
      proc.on('error', reject); // e.g. binary not found on PATH
      proc.on('close', (code) =>
        code === 0 ? resolve() : reject(new Error(`piper exited ${code}: ${stderr.slice(0, 300)}`)),
      );
      proc.stdin.write(text);
      proc.stdin.end();
    });

    try {
      return await readFile(tmp);
    } finally {
      void unlink(tmp).catch(() => {});
    }
  }

  private store(id: string, wav: Buffer): void {
    this.cache.set(id, wav);
    while (this.cache.size > CACHE_MAX) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }

  private clampVoice(v: VoiceParams): VoiceParams {
    const clamp = (n: number, [lo, hi]: readonly [number, number], d: number) =>
      Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
    return {
      lengthScale: clamp(v.lengthScale, VOICE_RANGES.lengthScale, VOICE_DEFAULTS.lengthScale),
      noiseScale: clamp(v.noiseScale, VOICE_RANGES.noiseScale, VOICE_DEFAULTS.noiseScale),
      noiseW: clamp(v.noiseW, VOICE_RANGES.noiseW, VOICE_DEFAULTS.noiseW),
      sentenceSilence: clamp(v.sentenceSilence, VOICE_RANGES.sentenceSilence, VOICE_DEFAULTS.sentenceSilence),
      speaker: Math.min(Math.max(0, Math.floor(Number(v.speaker) || 0)), Math.max(0, this.numSpeakers - 1)),
      volume: clamp(v.volume, VOICE_RANGES.volume, VOICE_DEFAULTS.volume),
    };
  }

  private async saveSetting(key: string, value: string): Promise<void> {
    await this.db.setting.upsert({ where: { key }, create: { key, value }, update: { value } });
  }
}

/** Parse a persisted JSON blob into a partial voice, tolerating garbage. */
function safeJson(s: string): Partial<VoiceParams> {
  try {
    const o = JSON.parse(s) as unknown;
    return o && typeof o === 'object' ? (o as Partial<VoiceParams>) : {};
  } catch {
    return {};
  }
}
