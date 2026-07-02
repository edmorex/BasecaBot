import { WebSocketServer, WebSocket } from 'ws';
import type { EventBus } from '../core/eventBus.js';
import { scopedLogger } from '../services/logger.js';

const log = scopedLogger('wsHub');

/** Envelope for every message across the hub, in both directions. */
export interface WsEnvelope {
  type: string;
  room: string;
  payload?: unknown;
  ts?: number;
}

interface HubOptions {
  port: number;
  secret: string;
  /** Channel to attach inbound app messages to when publishing BotEvents. */
  channel: string;
}

/**
 * WebSocket hub for web-app (game) integration.
 *
 * - Web apps connect with `?secret=...&room=<name>` and join a room.
 * - Bot -> apps: `broadcast(room, type, payload)` pushes chat-derived input.
 * - Apps -> bot: inbound messages are published on the EventBus as `wsMessage`
 *   events, which plugins subscribe to.
 *
 * This is transport-only; game logic lives in plugins and the web apps.
 */
export class WsHub {
  private wss?: WebSocketServer;
  private readonly rooms = new Map<string, Set<WebSocket>>();

  constructor(
    private readonly bus: EventBus,
    private readonly opts: HubOptions,
  ) {}

  start(): void {
    this.wss = new WebSocketServer({ port: this.opts.port });
    this.wss.on('connection', (socket, req) => this.onConnection(socket, req.url ?? ''));
    log.info({ port: this.opts.port }, 'WebSocket hub listening');
  }

  async stop(): Promise<void> {
    for (const set of this.rooms.values()) {
      for (const socket of set) socket.close(1001, 'server shutting down');
    }
    this.rooms.clear();
    await new Promise<void>((resolve) => {
      if (!this.wss) return resolve();
      this.wss.close(() => resolve());
    });
  }

  /** Push a message to every app connected to a room. */
  broadcast(room: string, type: string, payload?: unknown): void {
    const set = this.rooms.get(room);
    if (!set || set.size === 0) return;
    const data = JSON.stringify({ type, room, payload, ts: Date.now() } satisfies WsEnvelope);
    for (const socket of set) {
      if (socket.readyState === WebSocket.OPEN) socket.send(data);
    }
  }

  private onConnection(socket: WebSocket, url: string): void {
    const params = new URLSearchParams(url.split('?')[1] ?? '');
    if (params.get('secret') !== this.opts.secret) {
      log.warn('rejected ws connection: bad secret');
      socket.close(4001, 'unauthorized');
      return;
    }
    const room = params.get('room');
    if (!room) {
      socket.close(4002, 'room required');
      return;
    }

    this.join(room, socket);
    log.info({ room }, 'app connected to room');

    socket.on('message', (raw) => this.onMessage(room, raw.toString()));
    socket.on('close', () => this.leave(room, socket));
    socket.on('error', (err) => log.error({ err, room }, 'ws socket error'));
  }

  private onMessage(room: string, raw: string): void {
    let envelope: WsEnvelope;
    try {
      envelope = JSON.parse(raw) as WsEnvelope;
    } catch {
      log.warn({ room }, 'ignoring non-JSON ws message');
      return;
    }
    void this.bus.publish({
      type: 'wsMessage',
      channel: this.opts.channel,
      room,
      messageType: envelope.type,
      payload: envelope.payload,
      ts: Date.now(),
    });
  }

  private join(room: string, socket: WebSocket): void {
    let set = this.rooms.get(room);
    if (!set) {
      set = new Set();
      this.rooms.set(room, set);
    }
    set.add(socket);
  }

  private leave(room: string, socket: WebSocket): void {
    const set = this.rooms.get(room);
    set?.delete(socket);
    if (set && set.size === 0) this.rooms.delete(room);
    log.info({ room }, 'app disconnected from room');
  }
}
