/** Overlay API routes: the token-gated OBS overlay data (First results) and the
 * admin-only overlay URL listing. Free functions taking the WebServer. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { WebServer } from '../webServer.js';

export async function getFirstOverlayData(s: WebServer, req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  s.requireOverlayToken(req, url);
  const race = await s.first.currentRace();
  s.json(res, 200, race);
}

/** Serve a cached TTS clip by id (token-gated), same-origin, for the overlay to play. */
export function getTtsAudio(s: WebServer, req: IncomingMessage, res: ServerResponse, url: URL): void {
  s.requireOverlayToken(req, url);
  const id = url.pathname.slice('/overlays/tts/audio/'.length);
  const buf = /^[a-f0-9]{40}$/.test(id) ? s.tts.getAudio(id) : undefined;
  if (!buf) return s.send(res, 404, 'text/plain', 'Not Found');
  s.sendAudioBuffer(req, res, buf);
}

export async function getAdminOverlays(s: WebServer, req: IncomingMessage, res: ServerResponse): Promise<void> {
  s.requireAdmin(req);
  const token = s.config.overlayToken;
  const base = s.config.web.publicUrl;
  s.json(res, 200, {
    configured: !!token,
    token: token ?? null,
    overlays: token
      ? [
          { id: 'first', name: 'First — race results', url: `${base}/overlays/first?token=${encodeURIComponent(token)}` },
          { id: 'tts', name: 'TTS — audio source', url: `${base}/overlays/tts?token=${encodeURIComponent(token)}` },
        ]
      : [],
  });
}
