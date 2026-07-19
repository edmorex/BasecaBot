import { describe, it, expect, vi } from 'vitest';
import { buildSimEvent, isSimEventType, SIM_EVENT_TYPES } from './eventSimulator.js';
import type { UsersService } from './users.js';
import { PermissionLevel } from '../core/events.js';

/** A UsersService stub that just records who was persisted. */
function makeDeps() {
  const touched: { id: string; login: string; displayName: string }[] = [];
  const users = { touch: vi.fn(async (u) => void touched.push(u)) } as unknown as UsersService;
  return { deps: { users, defaultChannel: 'basecamp' }, touched };
}

describe('buildSimEvent', () => {
  it('accepts exactly the advertised event types', async () => {
    const { deps } = makeDeps();
    for (const t of SIM_EVENT_TYPES) {
      expect(isSimEventType(t)).toBe(true);
      expect(await buildSimEvent(deps, t, {})).toMatchObject({ type: t });
    }
    expect(isSimEventType('nope')).toBe(false);
    expect(await buildSimEvent(deps, 'nope', {})).toBeUndefined();
  });

  it('fills defaults when the payload is empty', async () => {
    const { deps } = makeDeps();
    expect(await buildSimEvent(deps, 'bits', {})).toMatchObject({ amount: 100, channel: 'basecamp' });
    expect(await buildSimEvent(deps, 'raid', {})).toMatchObject({ fromLogin: 'someraider', viewers: 10 });
    expect(await buildSimEvent(deps, 'donation', {})).toMatchObject({ fromName: 'TestDonor', amount: 5, currency: 'USD' });
  });

  it('coerces numeric fields sent as strings (they arrive from form inputs)', async () => {
    const { deps } = makeDeps();
    expect(await buildSimEvent(deps, 'bits', { amount: '250' })).toMatchObject({ amount: 250 });
    expect(await buildSimEvent(deps, 'resub', { months: '12' })).toMatchObject({ months: 12 });
  });

  // Point awards and the EventLog foreign key both require the user row to
  // exist, so anything carrying a user must persist it before publishing.
  it('persists the user for events that reference one', async () => {
    const { deps, touched } = makeDeps();
    await buildSimEvent(deps, 'sub', { user: 'Test Person' });
    expect(touched).toEqual([
      { id: 'sim-test_person', login: 'test_person', displayName: 'Test Person', permission: PermissionLevel.Subscriber },
    ]);
  });

  it('does not invent a user for events that have none', async () => {
    const { deps, touched } = makeDeps();
    await buildSimEvent(deps, 'raid', {});
    await buildSimEvent(deps, 'donation', {});
    expect(touched).toEqual([]);
  });

  it('honors an explicit channel over the default', async () => {
    const { deps } = makeDeps();
    expect(await buildSimEvent(deps, 'follow', { channel: 'guestchannel' })).toMatchObject({ channel: 'guestchannel' });
  });
});
