# Guest channels

BasecaBot lives in **one primary channel** (the broadcaster's). It can be
temporarily invited into **one other channel at a time** — a *guest channel* —
where it runs only a **whitelisted** set of features. Everything else in that
chat is ignored: no other commands run, no custom commands or phrases fire, and
guest chatters are never persisted.

- **`!connect <channel> [seconds]`** — bring the bot into a guest channel (from the
  primary channel only, Broadcaster+).
- **`!disconnect`** — pull it back out (Broadcaster+, from the primary **or** the
  guest channel). The bot also auto-leaves when the timer expires.

Durations are clamped to **30s – 24h**, defaulting to **6h**. Connecting while
already in a guest first leaves the old one.

Today two features are whitelisted for guest channels:

| Feature | What acts in the guest | Kind |
|---|---|---|
| **BasecaWheel** | `!wheel …` commands are forwarded to the wheel web app | owns a command |
| **Chat-activity stats overlay** | passively counts the guest's chat for an OBS overlay | consumes raw chat |

---

## The security model (why only whitelisted things act)

The important invariant: **in a guest channel the only side effect is what a
registered feature explicitly allows.** For the current set that means `!wheel`
acts and the stats overlay counts — nothing else.

This is enforced with defense-in-depth, because the stats overlay needs to *see*
every message (to count it), so the adapter forwards all guest chat onto the bus.
Three layers keep that firehose from turning into "every command runs in the
guest":

1. **Chat adapter** (`src/adapters/twitch/chatAdapter.ts`) — for a guest channel it
   forwards a message only if `GuestChannelService.shouldForwardGuestMessage()`
   says so: **all** messages when a `consumesRawChat` feature is active, otherwise
   only messages invoking a feature-owned command. Guest users are **never**
   persisted (`users.touch` stays primary-only).
2. **Command router** (`src/core/commandRouter.ts`) — before resolving *or* falling
   through to custom commands, it checks `guests.commandAllowed(channel, name)`. In
   a guest, only feature-owned command names run; every other built-in **and every
   custom command** (`!hug`, aliases, …) is dropped. The primary channel is always
   allowed, so timers/aliases there are unaffected.
3. **Custom-commands plugin** (`src/plugins/commands/index.ts`) — its phrase matcher
   skips guest channels entirely (phrases are primary-only).

Net effect in a guest channel:

```
viewer types…        result
──────────────       ─────────────────────────────────────
!wheel spin      →    forwarded to the wheel app  (whitelisted)
!disconnect      →    bot leaves                  (whitelisted, Broadcaster+)
!points          →    ignored (not whitelisted)
!somephrase      →    counted by the stats overlay, never acted on
hello everyone   →    counted by the stats overlay, never acted on
```

The mechanics (join/part, the auto-leave timer, greeting/farewell) live in
**`GuestChannelService`** (`src/services/guestChannels.ts`); the `!connect` /
`!disconnect` command surface is the small **guests plugin**
(`src/plugins/guests/index.ts`).

---

## Adding a new guest-capable feature

A plugin opts into guest channels by registering itself during `init()`:

```ts
ctx.guests.registerFeature({
  id: 'my-feature',
  ownedCommands: ['mycmd'],   // command names (no '!') allowed to run in a guest
  consumesRawChat: true,      // set if the feature passively reads ALL chat
});
```

- **`ownedCommands`** — these command names become allowed in a guest channel
  (added to `commandAllowed`). Everything else stays blocked.
- **`consumesRawChat`** — set this only for a passive observer (like the stats
  overlay). It makes the adapter forward *all* guest chat so the feature can read
  it. It does **not** widen the command allowlist — `commandAllowed` still gates
  which commands run, so raw-chat access can never be used to run arbitrary
  commands.

That's the whole contract — no kernel changes. The bot already knows how to join,
leave, gate, and clean up.

> A feature that reads raw chat should be a **pure observer**: read `chat` events,
> do its own thing (broadcast to an overlay, tally something). It must not call
> `ctx.chat.say` or otherwise act on guest messages — that's what the whitelist is
> protecting against.

---

## Feature: BasecaWheel in guest channels

The wheel registers `{ id: 'wheel', ownedCommands: ['wheel'] }`, so `!wheel …`
works in a guest exactly as it does in the primary channel. Each forwarded payload
carries the originating `channel`, and the web app echoes it back so results are
announced in the right chat. See [basecawheel-integration.md](basecawheel-integration.md)
for the wheel protocol itself.

---

## Feature: chat-activity stats overlay

A full-screen **1080p OBS overlay** showing live statistics about the chat the bot
is watching — the **focus channel**: the active guest if connected, else the
primary channel.

- **Overlay URL** — copy it from the dashboard's **Admin → Overlays** ("Chat
  activity — stats"). It carries the read-only overlay token; keep it private and
  don't show it on stream. Requires `OVERLAY_TOKEN` to be set (see
  [text-to-speech.md](text-to-speech.md) / `.env.example` for the token).
- **Add it in OBS** as a Browser Source (1920×1080, transparent background).

The overlay is a grid: **rows are the stats, columns are rolling time windows**
(`10s / 30s / 1m / 5m`).

| Stat | Meaning |
|---|---|
| Messages | messages sent in the window |
| Unique chatters | distinct users who spoke |
| Emotes used | total emote uses |
| Unique emotes | distinct emotes used |
| Most used emote | the single most-used emote + its count |
| Top chatters (messages) | top 3 users by message count |
| Top chatters (emotes) | top 3 users by emote count |

How it works: the **chatStats plugin** (`src/plugins/chatStats/index.ts`) registers
`{ id: 'chat-stats', consumesRawChat: true }`, buffers each `chat` event in a
rolling window (pruned to 5 minutes), and every ~1s broadcasts the focus channel's
computed stats to the `chat-stats` WebSocket-hub room, which the overlay renders.
The aggregation is pure, testable logic in `src/plugins/chatStats/aggregator.ts`.

> **Emote caveat.** Emote counts come from Twitch's IRC tags, so they cover
> **Twitch-native emotes only** (global / sub / emote-set). Third-party emotes
> (BTTV / FFZ / 7TV) live only in viewers' browser extensions and are not in the
> tags, so they are not counted.

This overlay is animation-free for now — a plain stats grid. Turning these numbers
into on-stream animations is a planned follow-up; the data feed (the `chat-stats`
room payload) already exists to drive it.
