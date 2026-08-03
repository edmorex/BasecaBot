/** Custom-command API routes (mod+): list/create/edit/delete commands + aliases,
 * and CSV import/export. Free functions taking the WebServer; wired in webServer.ts. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { WebServer } from '../webServer.js';
import { HttpError, LEVEL_LABELS, labelToLevel } from '../httpShared.js';
import { CommandError } from '../../services/customCommands.js';
import { COMMAND_CSV_SPEC } from '../../services/csv.js';

export async function getCommands(s: WebServer, res: ServerResponse): Promise<void> {
  const builtins = s.commands.list().map((c) => ({
    kind: 'builtin' as const, name: c.name, usage: c.usage ?? '', group: c.group ?? 'other', access: c.permission, description: c.description,
    response: null as string | null, target: null as string | null, args: null as string | null,
    globalCooldown: c.globalCooldown, userCooldown: c.userCooldown, enabled: true, usageCount: 0,
  }));
  const customs = (await s.customCommands.listForDashboard()).map((c) => ({
    kind: c.kind, name: c.name, usage: '', group: c.group, access: c.permission, description: '',
    response: c.response, target: c.target, args: c.args,
    globalCooldown: c.globalCooldown, userCooldown: c.userCooldown, enabled: c.enabled, usageCount: c.usageCount,
  }));
  const commands = [...builtins, ...customs].sort((a, b) => a.name.localeCompare(b.name));
  s.json(res, 200, { commands });
}

export async function postCommand(s: WebServer, req: IncomingMessage, res: ServerResponse): Promise<void> {
  s.requireManager(req);
  const body = await s.readJson(req);
  const target = s.targetFromBody(body);
  try {
    if ('response' in body) await s.customCommands.setResponse(target, body.response == null ? null : String(body.response));
    if ('group' in body) await s.customCommands.setGroup(target, String(body.group ?? ''));
    if ('permission' in body) await s.customCommands.setPermission(target, Number(body.permission) || 0);
    if ('globalCooldown' in body || 'userCooldown' in body) {
      await s.customCommands.setCooldown(target, Number(body.globalCooldown) || 0, Number(body.userCooldown) || 0);
    }
    if ('enabled' in body) await s.customCommands.setEnabled(target, Boolean(body.enabled));
    if ('usageCount' in body) await s.customCommands.setUsageCount(target, Number(body.usageCount) || 0);
  } catch (e) {
    if (e instanceof CommandError) throw new HttpError(400, e.message);
    throw e;
  }
  s.json(res, 200, { ok: true });
}

export async function createCommand(s: WebServer, req: IncomingMessage, res: ServerResponse): Promise<void> {
  s.requireManager(req);
  const body = await s.readJson(req);
  const target = s.targetFromBody(body);
  try {
    await s.customCommands.create(target, {
      response: body.response == null ? null : String(body.response),
      permission: Number(body.permission) || 0,
      globalCooldown: Number(body.globalCooldown) || 0,
      userCooldown: Number(body.userCooldown) || 0,
    });
    if (body.group != null && String(body.group).trim()) await s.customCommands.setGroup(target, String(body.group));
    if (body.enabled === false) await s.customCommands.setEnabled(target, false);
  } catch (e) {
    if (e instanceof CommandError) throw new HttpError(400, e.message);
    throw e;
  }
  s.json(res, 200, { ok: true });
}

export async function deleteCommand(s: WebServer, req: IncomingMessage, res: ServerResponse): Promise<void> {
  s.requireManager(req);
  const target = s.targetFromBody(await s.readJson(req));
  try {
    await s.customCommands.remove(target);
  } catch (e) {
    if (e instanceof CommandError) throw new HttpError(404, e.message);
    throw e;
  }
  s.json(res, 200, { ok: true });
}

export async function addCommandAlias(s: WebServer, req: IncomingMessage, res: ServerResponse): Promise<void> {
  s.requireManager(req);
  const body = await s.readJson(req);
  try {
    await s.customCommands.addAlias(String(body.alias ?? ''), String(body.target ?? ''), body.args == null ? null : String(body.args));
  } catch (e) {
    if (e instanceof CommandError) throw new HttpError(400, e.message);
    throw e;
  }
  s.json(res, 200, { ok: true });
}

export async function updateCommandAlias(s: WebServer, req: IncomingMessage, res: ServerResponse): Promise<void> {
  s.requireManager(req);
  const body = await s.readJson(req);
  try {
    await s.customCommands.updateAlias(String(body.alias ?? ''), {
      targetWord: 'target' in body ? String(body.target ?? '') : undefined,
      args: 'args' in body ? (body.args == null ? null : String(body.args)) : undefined,
      enabled: 'enabled' in body ? Boolean(body.enabled) : undefined,
    });
  } catch (e) {
    if (e instanceof CommandError) throw new HttpError(400, e.message);
    throw e;
  }
  s.json(res, 200, { ok: true });
}

export async function removeCommandAlias(s: WebServer, req: IncomingMessage, res: ServerResponse): Promise<void> {
  s.requireManager(req);
  const body = await s.readJson(req);
  try {
    await s.customCommands.removeAlias(String(body.alias ?? ''));
  } catch (e) {
    if (e instanceof CommandError) throw new HttpError(400, e.message);
    throw e;
  }
  s.json(res, 200, { ok: true });
}

export async function exportCommands(s: WebServer, req: IncomingMessage, res: ServerResponse): Promise<void> {
  s.requireManager(req);
  const rows: (string | number)[][] = [];
  for (const c of await s.customCommands.listForDashboard()) {
    rows.push([
      c.kind,
      c.name,
      c.response ?? '',
      c.group ?? '',
      LEVEL_LABELS[c.permission] ?? String(c.permission),
      c.enabled ? 'true' : 'false',
      c.globalCooldown,
      c.userCooldown,
      c.usageCount,
      c.target ?? '',
      c.args ?? '',
      c.createdAt ?? '',
      c.updatedAt ?? '',
    ]);
  }
  s.csvExport(res, 'commands.csv', ['Type', 'Name', 'Response', 'Group', 'Access', 'Enabled', 'Global Cooldown', 'User Cooldown', 'Uses', 'Target', 'Args', 'Created At', 'Updated At'], rows);
}

export async function importCommands(s: WebServer, req: IncomingMessage, res: ServerResponse): Promise<void> {
  s.requireManager(req);
  const { body, rows } = await s.parseCsvImport(req, COMMAND_CSV_SPEC);
  const mode = body.mode === 'replace' ? 'replace' : 'add';
  const items = rows.map((m) => {
    const type = (m.type ?? '').trim().toLowerCase();
    const kind = type === 'phrase' ? 'phrase' : type === 'alias' ? 'alias' : 'trigger';
    const en = (m.enabled ?? '').trim().toLowerCase();
    return {
      kind: kind as 'trigger' | 'phrase' | 'alias',
      name: m.name ?? '',
      response: m.response,
      group: m.group,
      permission: labelToLevel(m.access ?? ''),
      enabled: en === '' ? true : !['false', 'no', '0', 'off', 'disabled'].includes(en),
      globalCooldown: Number(m.globalCooldown) || 0,
      userCooldown: Number(m.userCooldown) || 0,
      usageCount: Number(m.usageCount) || 0,
      target: m.target,
      args: m.args,
      createdAt: m.createdAt,
      updatedAt: m.updatedAt,
    };
  });
  const result = await s.customCommands.importCommands(items, mode);
  s.json(res, 200, { ok: true, mode, ...result });
}
