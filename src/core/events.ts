/**
 * Canonical, provider-agnostic event model.
 *
 * Adapters (Twitch chat, EventSub, donation providers, the WebSocket hub)
 * translate their raw payloads into these `BotEvent`s and publish them on the
 * EventBus. Plugins subscribe to these types and never touch provider SDKs.
 *
 * Because the union is defined here up front, an event like `donation` can
 * exist and be handled by plugins before any real provider adapter emits it.
 */

/** Permission tiers, ordered from lowest to highest privilege. */
export enum PermissionLevel {
  Viewer = 0,
  Subscriber = 1,
  Vip = 2,
  Moderator = 3,
  Broadcaster = 4,
  Admin = 5,
}

/** A chat user as seen by the bot, normalized across providers. */
export interface EventUser {
  /** Stable provider user id (Twitch user id). */
  id: string;
  /** Login name (lowercase). */
  login: string;
  /** Display name (original casing). */
  displayName: string;
  /** Highest permission level resolved for this user in this context. */
  permission: PermissionLevel;
}

interface BaseEvent {
  /** Channel login the event belongs to (lowercase). */
  channel: string;
  /** Epoch milliseconds when the adapter observed the event. */
  ts: number;
}

/** A plain chat message. */
export interface ChatEvent extends BaseEvent {
  type: 'chat';
  user: EventUser;
  message: string;
}

/** A parsed command invocation (`!name arg1 arg2`). */
export interface CommandEvent extends BaseEvent {
  type: 'command';
  user: EventUser;
  /** Command name without the prefix, lowercased. */
  name: string;
  /** Raw argument string after the command name. */
  argString: string;
  /** Whitespace-split arguments. */
  args: string[];
  /** The full original message. */
  raw: string;
}

export interface SubEvent extends BaseEvent {
  type: 'sub';
  user: EventUser;
  /** e.g. '1000', '2000', '3000', 'Prime'. */
  tier: string;
  months: number;
  message?: string;
}

export interface ResubEvent extends BaseEvent {
  type: 'resub';
  user: EventUser;
  tier: string;
  months: number;
  message?: string;
}

export interface SubGiftEvent extends BaseEvent {
  type: 'subgift';
  gifter: EventUser;
  recipientLogin: string;
  tier: string;
  count: number;
}

export interface BitsEvent extends BaseEvent {
  type: 'bits';
  user: EventUser;
  amount: number;
  message?: string;
}

export interface RaidEvent extends BaseEvent {
  type: 'raid';
  fromLogin: string;
  viewers: number;
}

export interface FollowEvent extends BaseEvent {
  type: 'follow';
  user: EventUser;
}

/** Cash donation (from StreamElements/StreamLabs — wired later). */
export interface DonationEvent extends BaseEvent {
  type: 'donation';
  fromName: string;
  amount: number;
  currency: string;
  message?: string;
}

/** Channel-point redemption (future). */
export interface RedemptionEvent extends BaseEvent {
  type: 'redemption';
  user: EventUser;
  rewardId: string;
  rewardTitle: string;
  input?: string;
}

/** A message received from a connected web app over the WebSocket hub. */
export interface WsMessageEvent extends BaseEvent {
  type: 'wsMessage';
  room: string;
  messageType: string;
  payload: unknown;
}

export type BotEvent =
  | ChatEvent
  | CommandEvent
  | SubEvent
  | ResubEvent
  | SubGiftEvent
  | BitsEvent
  | RaidEvent
  | FollowEvent
  | DonationEvent
  | RedemptionEvent
  | WsMessageEvent;

export type BotEventType = BotEvent['type'];

/** Helper: map an event type string to its concrete event shape. */
export type EventOfType<T extends BotEventType> = Extract<BotEvent, { type: T }>;
