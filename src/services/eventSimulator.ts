import { PermissionLevel, type BotEvent, type EventUser } from '../core/events.js';
import type { UsersService } from './users.js';

/** The event types the simulator can inject. */
export const SIM_EVENT_TYPES = ['sub', 'resub', 'subgift', 'bits', 'raid', 'follow', 'donation'] as const;
export type SimEventType = (typeof SIM_EVENT_TYPES)[number];

export function isSimEventType(t: string): t is SimEventType {
  return (SIM_EVENT_TYPES as readonly string[]).includes(t);
}

/** What building a simulated event needs, independent of how it was requested. */
export interface SimDeps {
  users: UsersService;
  /** Channel to attribute the event to when the payload doesn't name one. */
  defaultChannel: string;
}

/** Build a synthetic EventUser from a display name (stable id per login). */
function makeUser(displayName: string | undefined, permission = PermissionLevel.Viewer): EventUser {
  const name = (displayName ?? 'TestUser').trim() || 'TestUser';
  const login = name.toLowerCase().replace(/[^a-z0-9_]/g, '_');
  return { id: `sim-${login}`, login, displayName: name, permission };
}

const str = (v: unknown, d = ''): string => (typeof v === 'string' ? v : d);
const num = (v: unknown, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || d);

/**
 * Normalize a simulator payload into a real BotEvent, persisting any user it
 * references first (point awards and the EventLog foreign key both need the row
 * to exist). Returns undefined for an unknown event type.
 *
 * Shared by the WebSocket harness and the admin dashboard so both produce
 * byte-identical events — there is one definition of what "a simulated sub"
 * means, and neither entry point can drift from the other.
 */
export async function buildSimEvent(
  deps: SimDeps,
  type: string,
  payload: Record<string, unknown>,
): Promise<BotEvent | undefined> {
  const channel = str(payload.channel) || deps.defaultChannel;
  const ts = Date.now();

  switch (type) {
    case 'sub': {
      const user = makeUser(str(payload.user, 'TestUser'), PermissionLevel.Subscriber);
      await deps.users.touch(user);
      return { type: 'sub', channel, ts, user, tier: str(payload.tier, '1000'), months: num(payload.months, 1), message: str(payload.message) || undefined };
    }
    case 'resub': {
      const user = makeUser(str(payload.user, 'TestUser'), PermissionLevel.Subscriber);
      await deps.users.touch(user);
      return { type: 'resub', channel, ts, user, tier: str(payload.tier, '1000'), months: num(payload.months, 1), message: str(payload.message) || undefined };
    }
    case 'subgift': {
      const gifter = makeUser(str(payload.gifter, 'TestGifter'));
      await deps.users.touch(gifter);
      return { type: 'subgift', channel, ts, gifter, recipientLogin: str(payload.recipientLogin), tier: str(payload.tier, '1000'), count: num(payload.count, 1) };
    }
    case 'bits': {
      const user = makeUser(str(payload.user, 'TestUser'));
      await deps.users.touch(user);
      return { type: 'bits', channel, ts, user, amount: num(payload.amount, 100), message: str(payload.message) || undefined };
    }
    case 'raid':
      return { type: 'raid', channel, ts, fromLogin: str(payload.fromLogin, 'someraider'), viewers: num(payload.viewers, 10) };
    case 'follow': {
      const user = makeUser(str(payload.user, 'TestUser'));
      await deps.users.touch(user);
      return { type: 'follow', channel, ts, user };
    }
    case 'donation':
      return { type: 'donation', channel, ts, fromName: str(payload.fromName, 'TestDonor'), amount: num(payload.amount, 5), currency: str(payload.currency, 'USD'), message: str(payload.message) || undefined };
    default:
      return undefined;
  }
}
