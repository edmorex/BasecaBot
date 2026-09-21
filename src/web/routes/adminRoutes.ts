/** Admin API routes (broadcaster / bot admin only): user administration, editable
 * text strings, and the event simulator. Free functions taking the WebServer. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { WebServer } from '../webServer.js';
import { HttpError, LEVEL_LABELS } from '../httpShared.js';
import { AliasError } from '../../services/users.js';
import type { VoiceParams } from '../../services/tts.js';
import { FloofError, MAX_IMAGE_BYTES, type FloofConfig } from '../../services/floof.js';
import { PermissionLevel } from '../../core/events.js';
import { buildSimEvent, isSimEventType } from '../../services/eventSimulator.js';

export async function getAdminUsers(s: WebServer, req: IncomingMessage, res: ServerResponse): Promise<void> {
  s.requireAdmin(req);
  const [rows, roles] = await Promise.all([s.users.listForAdmin(), s.relationships.roleSets()]);
  const broadcaster = s.config.twitch.channel.toLowerCase();
  const admins = new Set(s.config.twitch.admins.map((a) => a.toLowerCase()));

  const users = rows.map((u) => {
    let permission = PermissionLevel.Viewer;
    if (roles.subscribers.has(u.id)) permission = PermissionLevel.Subscriber;
    if (roles.vips.has(u.id)) permission = PermissionLevel.Vip;
    if (roles.moderators.has(u.id)) permission = PermissionLevel.Moderator;
    if (u.login === broadcaster) permission = PermissionLevel.Broadcaster;
    if (admins.has(u.login)) permission = PermissionLevel.Admin;
    return { ...u, permission, permissionLabel: LEVEL_LABELS[permission] ?? String(permission) };
  });

  s.json(res, 200, { users });
}

export function getAdminStrings(s: WebServer, req: IncomingMessage, res: ServerResponse): void {
  s.requireAdmin(req);
  s.json(res, 200, { groups: s.text.list() });
}

export async function postAdminString(s: WebServer, req: IncomingMessage, res: ServerResponse): Promise<void> {
  s.requireAdmin(req);
  const body = await s.readJson(req);
  const feature = String(body.feature ?? '').trim();
  const key = String(body.key ?? '').trim();
  if (!feature || !key) throw new HttpError(400, 'Missing feature or key.');
  if (body.reset) await s.text.reset(feature, key);
  else await s.text.set(feature, key, String(body.value ?? ''));
  s.json(res, 200, { ok: true });
}

// ── Text-to-Speech ────────────────────────────────────────────────────────────

/** Friendly messages for a non-ok `TtsService.speak()` reason. */
const SPEAK_ERRORS: Record<string, string> = {
  empty: 'Enter something to say.',
  'too-long': 'Message is too long.',
  unconfigured: 'TTS is not configured (set PIPER_MODEL and restart).',
  muted: 'TTS is muted — unmute to test.',
  'synth-failed': 'Speech synthesis failed — check the piper binary and voice model.',
};

export function getAdminTts(s: WebServer, req: IncomingMessage, res: ServerResponse): void {
  s.requireAdmin(req);
  s.json(res, 200, {
    configured: s.tts.configured,
    muted: s.tts.isMuted(),
    voice: s.tts.getVoice(),
    speakers: s.tts.getSpeakers(),
    defaults: s.tts.defaults,
  });
}

export async function postAdminTts(s: WebServer, req: IncomingMessage, res: ServerResponse): Promise<void> {
  s.requireAdmin(req);
  const body = await s.readJson(req);
  if ('muted' in body) await s.tts.setMuted(!!body.muted);
  if (body.voice && typeof body.voice === 'object') await s.tts.setVoice(body.voice as Partial<VoiceParams>);
  s.json(res, 200, { ok: true, muted: s.tts.isMuted(), voice: s.tts.getVoice() });
}

export async function postAdminTtsSay(s: WebServer, req: IncomingMessage, res: ServerResponse): Promise<void> {
  s.requireAdmin(req);
  const body = await s.readJson(req);
  const text = String(body.text ?? '').trim();
  if (!text) throw new HttpError(400, 'Enter something to say.');
  const result = await s.tts.speak(text, { source: 'admin' });
  if (!result.ok) {
    throw new HttpError(result.reason === 'muted' ? 409 : 400, SPEAK_ERRORS[result.reason ?? ''] ?? 'Could not speak.');
  }
  s.json(res, 200, { ok: true });
}

/** "Test Voice": synthesize and return the wav bytes to play on the dashboard
 * (no overlay broadcast; works even when muted). GET so an <audio> element can
 * point straight at it — a same-origin URL plays under the page CSP (a fetched
 * blob: URL would not), and play() stays inside the click's user gesture. */
export async function getAdminTtsPreview(s: WebServer, req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  s.requireAdmin(req);
  const text = (url.searchParams.get('text') ?? '').trim();
  if (!text) throw new HttpError(400, 'Enter something to say.');
  const result = await s.tts.preview(text);
  if (!result.ok) throw new HttpError(400, SPEAK_ERRORS[result.reason ?? ''] ?? 'Could not synthesize.');
  s.sendAudioBuffer(req, res, result.wav);
}

export async function initAdminUser(s: WebServer, req: IncomingMessage, res: ServerResponse): Promise<void> {
  s.requireAdmin(req);
  const body = await s.readJson(req);
  const handle = String(body.handle ?? '');
  try {
    const user = await s.users.initByHandle(handle);
    if (!user) throw new HttpError(404, `There's no Twitch account called @${handle.replace(/^@/, '')}.`);
    s.json(res, 200, { ok: true, user });
  } catch (e) {
    if (e instanceof AliasError) throw new HttpError(400, e.message);
    throw e;
  }
}

export async function updateAdminUser(s: WebServer, req: IncomingMessage, res: ServerResponse): Promise<void> {
  s.requireAdmin(req);
  const body = await s.readJson(req);
  const id = String(body.id ?? '');
  if (!id) throw new HttpError(400, 'Provide a user id.');
  if (!(await s.users.getById(id))) throw new HttpError(404, 'Unknown user.');

  try {
    if (typeof body.displayName === 'string' && body.displayName.trim()) {
      await s.users.setDisplayName(id, body.displayName);
    }
    for (const alias of Array.isArray(body.addAliases) ? body.addAliases : []) {
      await s.users.addAlias(id, String(alias));
    }
    for (const alias of Array.isArray(body.removeAliases) ? body.removeAliases : []) {
      await s.users.removeAlias(id, String(alias));
    }
    if (body.points != null && body.points !== '') {
      const points = Number(body.points);
      if (!Number.isFinite(points) || points < 0) throw new HttpError(400, 'Points must be zero or more.');
      await s.points.setBalance(id, points);
    }
  } catch (e) {
    if (e instanceof AliasError) throw new HttpError(400, e.message);
    throw e;
  }

  s.json(res, 200, { ok: true });
}

export async function deleteAdminUser(s: WebServer, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const session = s.requireAdmin(req);
  const body = await s.readJson(req);
  const id = String(body.id ?? '');
  const target = id ? await s.users.getById(id) : null;
  if (!target) throw new HttpError(404, 'Unknown user.');
  if (target.login === s.config.twitch.channel.toLowerCase()) {
    throw new HttpError(400, 'The broadcaster account cannot be deleted.');
  }
  if (id === session.user.id) throw new HttpError(400, 'You cannot delete your own account.');

  await s.users.deleteUser(id);
  s.json(res, 200, { ok: true });
}

export async function simulateEvent(s: WebServer, req: IncomingMessage, res: ServerResponse): Promise<void> {
  s.requireAdmin(req);
  const body = await s.readJson(req);
  const type = String(body.type ?? '');
  if (!isSimEventType(type)) throw new HttpError(400, `Unknown event type "${type}".`);

  const payload = (body.payload ?? {}) as Record<string, unknown>;
  const event = await buildSimEvent(
    { users: s.users, defaultChannel: s.config.twitch.channel },
    type,
    payload,
  );
  if (!event) throw new HttpError(400, `Could not build a "${type}" event.`);

  await s.bus.publish(event);
  s.json(res, 200, { ok: true, injected: event.type });
}

// ── Achievements ──────────────────────────────────────────────────────────────

/** The catalog plus how many users hold each, for the admin management view. */
export async function getAdminAchievements(s: WebServer, req: IncomingMessage, res: ServerResponse): Promise<void> {
  s.requireAdmin(req);
  const holders = await s.achievements.holderCounts();
  const achievements = s.achievements.catalog.map((d) => ({
    key: d.key,
    name: d.name,
    description: d.description,
    emoji: d.emoji,
    tier: d.tier,
    group: d.group,
    target: d.target,
    repeatable: !!d.keyFor,
    holders: holders[d.key] ?? 0,
  }));
  s.json(res, 200, {
    achievements,
    totals: { catalog: achievements.length, awarded: Object.values(holders).reduce((n, c) => n + c, 0) },
  });
}

/**
 * Fire a FAKE unlock so the OBS overlay can be validated without waiting for a
 * real one. Nothing is written to the database.
 *
 * `announce: false` (default) broadcasts straight to the overlay room — card only,
 * no chat spam while you're positioning the source. `announce: true` publishes the
 * real `achievementUnlocked` event instead, exercising the full path (overlay card
 * AND the chat announcement) exactly as a genuine unlock would.
 */
export async function postAdminAchievementSimulate(s: WebServer, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const session = s.requireAdmin(req);
  const body = await s.readJson(req);
  const key = String(body.key ?? '');
  const def = s.achievements.catalog.find((d) => d.key === key);
  if (!def) throw new HttpError(400, `Unknown achievement "${key}".`);
  const displayName = String(body.user ?? '').trim() || session.user.displayName;

  if (body.announce) {
    await s.bus.publish({
      type: 'achievementUnlocked',
      channel: s.config.twitch.channel,
      ts: Date.now(),
      userId: `simulated:${session.user.id}`,
      displayName,
      key: def.key,
      name: def.name,
      description: def.description,
      emoji: def.emoji,
      tier: def.tier,
      value: def.target,
    });
  } else {
    s.ws.broadcast('achievements', 'unlocked', {
      user: displayName,
      key: def.key,
      emoji: def.emoji,
      name: def.name,
      description: def.description,
      tier: def.tier,
    });
  }
  s.json(res, 200, { ok: true, announced: !!body.announce });
}

/** Grant everything users' history already satisfies (silent, idempotent). */
export async function postAdminAchievementBackfill(s: WebServer, req: IncomingMessage, res: ServerResponse): Promise<void> {
  s.requireAdmin(req);
  const result = await s.achievements.backfillAll();
  s.json(res, 200, { ok: true, ...result });
}

// ── Pet the Floof ─────────────────────────────────────────────────────────────

export async function getAdminFloof(s: WebServer, req: IncomingMessage, res: ServerResponse): Promise<void> {
  s.requireAdmin(req);
  const [images] = await Promise.all([s.floof.listImages()]);
  s.json(res, 200, { config: s.floof.getConfig(), defaults: s.floof.defaults, images, maxBytes: MAX_IMAGE_BYTES });
}

export async function postAdminFloof(s: WebServer, req: IncomingMessage, res: ServerResponse): Promise<void> {
  s.requireAdmin(req);
  const body = await s.readJson(req);
  const config = await s.floof.setConfig((body.config ?? body) as Partial<FloofConfig>);
  s.json(res, 200, { ok: true, config });
}

/** Spawn a floof right now — bypasses the enable switch AND the live check. */
export async function postAdminFloofFire(s: WebServer, req: IncomingMessage, res: ServerResponse): Promise<void> {
  s.requireAdmin(req);
  const problem = await s.floof.requestSpawn();
  if (problem) throw new HttpError(409, problem);
  s.json(res, 200, { ok: true });
}

/**
 * Upload a floof PNG. The body is the RAW file (no multipart parsing needed:
 * `fetch(url, { body: file })`), with the filename in `?name=`. The service
 * validates it really is a PNG and really is square, from its own IHDR header.
 */
export async function postAdminFloofImage(s: WebServer, req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  s.requireAdmin(req);
  const name = url.searchParams.get('name') ?? 'floof.png';
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const c of req) {
    const buf = c as Buffer;
    total += buf.length;
    if (total > MAX_IMAGE_BYTES) throw new HttpError(413, `Image is too large (max ${Math.floor(MAX_IMAGE_BYTES / 1024 / 1024)}MB).`);
    chunks.push(buf);
  }
  try {
    const image = await s.floof.saveImage(name, Buffer.concat(chunks));
    s.json(res, 200, { ok: true, image });
  } catch (e) {
    if (e instanceof FloofError) throw new HttpError(400, e.message);
    throw e;
  }
}

export async function postAdminFloofImageDelete(s: WebServer, req: IncomingMessage, res: ServerResponse): Promise<void> {
  s.requireAdmin(req);
  const body = await s.readJson(req);
  try {
    await s.floof.deleteImage(String(body.name ?? ''));
    s.json(res, 200, { ok: true });
  } catch (e) {
    if (e instanceof FloofError) throw new HttpError(400, e.message);
    throw e;
  }
}
