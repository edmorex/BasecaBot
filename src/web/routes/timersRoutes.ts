/** Timer API routes (mod+): list, create, update, delete, and loop toggle.
 * Free functions taking the WebServer; wired in webServer.ts. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { WebServer } from '../webServer.js';
import { HttpError } from '../httpShared.js';
import { TimerError } from '../../services/timers.js';

export async function getTimers(s: WebServer, res: ServerResponse): Promise<void> {
  const timers = await s.timers.list();
  s.json(res, 200, { timers });
}

export async function createTimer(s: WebServer, req: IncomingMessage, res: ServerResponse): Promise<void> {
  s.requireManager(req);
  const body = await s.readJson(req);
  try {
    await s.timers.add(String(body.name ?? ''), Number(body.periodSeconds), String(body.command ?? ''));
  } catch (e) {
    if (e instanceof TimerError) throw new HttpError(400, e.message);
    throw e;
  }
  s.json(res, 200, { ok: true });
}

export async function updateTimer(s: WebServer, req: IncomingMessage, res: ServerResponse): Promise<void> {
  s.requireManager(req);
  const body = await s.readJson(req);
  try {
    await s.timers.edit(String(body.name ?? ''), Number(body.periodSeconds), String(body.command ?? ''));
  } catch (e) {
    if (e instanceof TimerError) throw new HttpError(400, e.message);
    throw e;
  }
  s.json(res, 200, { ok: true });
}

export async function deleteTimer(s: WebServer, req: IncomingMessage, res: ServerResponse): Promise<void> {
  s.requireManager(req);
  const body = await s.readJson(req);
  try {
    await s.timers.delete(String(body.name ?? ''));
  } catch (e) {
    if (e instanceof TimerError) throw new HttpError(404, e.message);
    throw e;
  }
  s.json(res, 200, { ok: true });
}

export async function setTimerLoop(s: WebServer, req: IncomingMessage, res: ServerResponse): Promise<void> {
  s.requireManager(req);
  const body = await s.readJson(req);
  try {
    if (body.on) await s.timers.loop(String(body.name ?? ''));
    else await s.timers.stop(String(body.name ?? ''));
  } catch (e) {
    if (e instanceof TimerError) throw new HttpError(400, e.message);
    throw e;
  }
  s.json(res, 200, { ok: true });
}
