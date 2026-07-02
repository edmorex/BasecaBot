import { describe, it, expect, vi, afterEach } from 'vitest';
import { WebSocket } from 'ws';
import { WsHub, type WsEnvelope } from './wsHub.js';
import { EventBus } from '../core/eventBus.js';

const PORT = 8199;
const SECRET = 'test-secret';
const ROOM = 'sample-game';

let hub: WsHub | undefined;

afterEach(async () => {
  await hub?.stop();
  hub = undefined;
});

function connect(query: string): Promise<WebSocket> {
  const socket = new WebSocket(`ws://localhost:${PORT}${query}`);
  return new Promise((resolve, reject) => {
    socket.on('open', () => resolve(socket));
    socket.on('error', reject);
    socket.on('close', (code) => reject(new Error(`closed ${code}`)));
  });
}

describe('WsHub (integration)', () => {
  it('rejects connections with a bad secret', async () => {
    const bus = new EventBus();
    hub = new WsHub(bus, { port: PORT, secret: SECRET, channel: 'test' });
    hub.start();

    const closeCode = await new Promise<number>((resolve) => {
      const socket = new WebSocket(`ws://localhost:${PORT}?room=${ROOM}&secret=wrong`);
      socket.on('close', (code) => resolve(code));
      socket.on('error', () => {}); // swallow; a close with a 4xxx code is expected
    });
    expect(closeCode).toBe(4001);
  });

  it('broadcasts bot -> app and publishes app -> bus', async () => {
    const bus = new EventBus();
    const onWs = vi.fn();
    bus.on('wsMessage', onWs);

    hub = new WsHub(bus, { port: PORT, secret: SECRET, channel: 'mychannel' });
    hub.start();

    const client = await connect(`?room=${ROOM}&secret=${SECRET}`);

    // bot -> app
    const received = new Promise<WsEnvelope>((resolve) => {
      client.on('message', (raw) => resolve(JSON.parse(raw.toString())));
    });
    // Give the server a tick to register the room membership.
    await new Promise((r) => setTimeout(r, 20));
    hub.broadcast(ROOM, 'gameStart', { hello: 'world' });
    const envelope = await received;
    expect(envelope).toMatchObject({ type: 'gameStart', room: ROOM, payload: { hello: 'world' } });

    // app -> bot (published as a wsMessage BotEvent)
    client.send(JSON.stringify({ type: 'result', room: ROOM, payload: { winner: 'alice' } }));
    await vi.waitFor(() => expect(onWs).toHaveBeenCalled());
    expect(onWs).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'wsMessage',
        room: ROOM,
        messageType: 'result',
        channel: 'mychannel',
        payload: { winner: 'alice' },
      }),
    );

    client.close();
  });
});
