/** Named-list API routes: list CRUD, entry add/edit/delete, and CSV import/export
 * (auth is per-list). Free functions taking the WebServer; wired in webServer.ts. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { WebServer } from '../webServer.js';
import { HttpError, LEVEL_LABELS } from '../httpShared.js';
import { ListError } from '../../services/lists.js';
import { LIST_CSV_SPEC } from '../../services/csv.js';
import { PermissionLevel } from '../../core/events.js';

export async function getLists(s: WebServer, res: ServerResponse): Promise<void> {
  const lists = await s.lists.listAllForDashboard();
  s.json(res, 200, { lists });
}

export async function createList(s: WebServer, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const session = s.requireManager(req);
  const body = await s.readJson(req);
  const name = String(body.name ?? '').trim();
  const actor = { id: session.user.id, displayName: session.user.displayName };
  try {
    await s.lists.create(name, body.displayName == null ? undefined : String(body.displayName), actor);
    if (body.description != null && String(body.description).trim()) await s.lists.setDescription(name, String(body.description));
    if (body.permission != null) await s.lists.setPermission(name, Number(body.permission) || PermissionLevel.Moderator);
  } catch (e) {
    if (e instanceof ListError) throw new HttpError(400, e.message);
    throw e;
  }
  s.json(res, 200, { ok: true });
}

export async function updateList(s: WebServer, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await s.readJson(req);
  const name = String(body.name ?? '').trim();
  try {
    await s.requireListManage(req, name);
    if ('displayName' in body) await s.lists.setDisplayName(name, String(body.displayName ?? ''));
    if ('description' in body) await s.lists.setDescription(name, String(body.description ?? ''));
    if ('permission' in body) await s.lists.setPermission(name, Number(body.permission) || 0);
    if (body.newName != null && String(body.newName).trim()) await s.lists.rename(name, String(body.newName));
  } catch (e) {
    if (e instanceof ListError) throw new HttpError(400, e.message);
    throw e;
  }
  s.json(res, 200, { ok: true });
}

export async function deleteList(s: WebServer, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await s.readJson(req);
  const name = String(body.name ?? '').trim();
  try {
    await s.requireListManage(req, name);
    await s.lists.remove(name);
  } catch (e) {
    if (e instanceof ListError) throw new HttpError(400, e.message);
    throw e;
  }
  s.json(res, 200, { ok: true });
}

export async function addListEntry(s: WebServer, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const session = s.requireApiSession(req);
  const body = await s.readJson(req);
  const name = String(body.list ?? '').trim();
  try {
    const level = await s.lists.addPermission(name);
    if (s.sessionLevel(session) < level) throw new HttpError(403, `Only ${LEVEL_LABELS[level]}+ can add to this list.`);
    await s.lists.addEntry(name, String(body.text ?? ''), { id: session.user.id, displayName: session.user.displayName });
  } catch (e) {
    if (e instanceof ListError) throw new HttpError(400, e.message);
    throw e;
  }
  s.json(res, 200, { ok: true });
}

export async function updateListEntry(s: WebServer, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await s.readJson(req);
  const name = String(body.list ?? '').trim();
  try {
    await s.requireListManage(req, name);
    await s.lists.updateEntry(name, Number(body.id), String(body.text ?? ''));
  } catch (e) {
    if (e instanceof ListError) throw new HttpError(400, e.message);
    throw e;
  }
  s.json(res, 200, { ok: true });
}

export async function deleteListEntry(s: WebServer, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await s.readJson(req);
  const name = String(body.list ?? '').trim();
  try {
    await s.requireListManage(req, name);
    await s.lists.removeEntry(name, Number(body.id));
  } catch (e) {
    if (e instanceof ListError) throw new HttpError(400, e.message);
    throw e;
  }
  s.json(res, 200, { ok: true });
}

export async function exportLists(s: WebServer, req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  s.requireManager(req);
  const scope = url.searchParams.get('scope') === 'active' ? 'active' : 'all';
  const only = (url.searchParams.get('list') ?? '').toLowerCase();
  let lists = await s.lists.listAllForDashboard();
  if (scope === 'active') lists = lists.filter((l) => l.name === only);
  const rows: (string | number)[][] = [];
  for (const l of lists) {
    const meta = [l.name, l.displayName ?? '', l.description ?? '', LEVEL_LABELS[l.permission] ?? String(l.permission), l.createdByName ?? '', l.createdById ?? '', l.createdAt, l.updatedAt];
    if (l.entries.length === 0) rows.push([...meta, '', '', '', '']);
    else for (const e of l.entries) rows.push([...meta, e.text, e.addedByName ?? '', e.addedById ?? '', e.addedAt]);
  }
  s.csvExport(res, scope === 'active' && only ? `${only}.csv` : 'lists.csv', ['List', 'Display Name', 'Description', 'Permission', 'Created By', 'Created By ID', 'List Created At', 'List Updated At', 'Entry', 'Added By', 'Added By ID', 'Date Added'], rows);
}

export async function importLists(s: WebServer, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const { body, rows: mapped } = await s.parseCsvImport(req, LIST_CSV_SPEC);
  const mode = String(body.mode ?? '');
  const activeName = String(body.list ?? '').trim();
  try {
    if (mode === 'replace-all') {
      const session = await s.requireBulkListManager(req);
      const count = await s.lists.replaceAllLists(s.groupLists(mapped), { id: session.user.id, displayName: session.user.displayName });
      s.json(res, 200, { ok: true, mode, lists: count });
      return;
    }
    await s.requireListManage(req, activeName);
    const entries = mapped.filter((m) => (m.text ?? '').trim()).map((m) => ({ text: m.text!, addedByName: m.addedByName, addedById: m.addedById, addedAt: m.addedAt }));
    const added = mode === 'replace' ? await s.lists.replaceEntries(activeName, entries) : await s.lists.addEntries(activeName, entries);
    s.json(res, 200, { ok: true, mode, added });
  } catch (e) {
    if (e instanceof ListError) throw new HttpError(400, e.message);
    throw e;
  }
}
