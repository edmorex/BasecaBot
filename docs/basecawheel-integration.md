# BasecaWheel ↔ BasecaBot WebSocket Integration Spec

This document describes how the **BasecaWheel** web app must connect to and communicate with **BasecaBot** so that Twitch chat commands (`!wheel title`, `!wheel add`, `!wheel spin`, `!wheel clear`, `!wheel reset`) drive the wheel, and the wheel can optionally speak back in chat.

The bot side is already implemented. This spec is what BasecaWheel needs to implement.

---

## 1. Connection

BasecaBot runs a WebSocket **hub**. BasecaWheel is a **client** that connects to it.

**URL:**

```
ws://<BOT_HOST>:<WS_HUB_PORT>?room=baseca-wheel&secret=<WS_HUB_SECRET>
```

- `<BOT_HOST>` — where the bot runs (`localhost` during local dev).
- `<WS_HUB_PORT>` — the bot's `WS_HUB_PORT` (default `8080`).
- `room` — **must be exactly `baseca-wheel`**. This is how the bot routes wheel messages to this app.
- `secret` — **must equal the bot's `WS_HUB_SECRET`** env value. A wrong/absent secret closes the socket with code **4001**; a missing `room` closes with **4002**.

There is no separate handshake message — joining the room happens via the query string on connect.

**Reconnection:** the app should auto-reconnect with backoff if the socket closes (e.g. bot restart). On reconnect, just open the same URL again.

---

## 2. Message envelope (both directions)

Every message on the socket is JSON with this shape:

```json
{
  "type": "string",     // message kind
  "room": "baseca-wheel",
  "payload": { },        // kind-specific object
  "ts": 1730000000000    // epoch ms (set by sender; optional on messages you send)
}
```

Always include `"room": "baseca-wheel"` on messages you send to the bot.

---

## 3. Messages the app RECEIVES (bot → wheel)

One message type: **`wheel`**. The specific action is in `payload.command`.

```jsonc
{
  "type": "wheel",
  "room": "baseca-wheel",
  "payload": {
    "command": "title" | "add" | "spin" | "clear" | "reset",
    "text": "string",     // title text / entry text; "" for spin/clear/reset
    "user": "string",     // Twitch DISPLAY name of the sender
    "permission": 0        // integer, see table below
  },
  "ts": 1730000000000
}
```

### Command semantics

| `command` | Triggered by chat | `text` contains | The app should… |
|-----------|-------------------|-----------------|-----------------|
| `title`   | `!wheel title <text>` | the new wheel title | set the wheel's title to `text` |
| `add`     | `!wheel add <text>`   | the entry to add    | add `text` as a wheel entry (subject to the app's per-user limit) |
| `spin`    | `!wheel spin`         | `""` (empty)        | spin the wheel and pick a winner |
| `clear`   | `!wheel clear`        | `""` (empty)        | remove **only this `user`'s own** entries (self-service; open to everyone). Reset that user's add-count so they can re-add |
| `reset`   | `!wheel reset`        | `""` (empty)        | wipe the **entire** wheel (all entries, title). Intended for higher-privilege users — gate on `permission` |

`clear`, `spin`, and `reset` carry no `text` (always `""`); any words a user types after them are ignored by the bot. Only `title` and `add` carry text.

### `permission` values

Integer matching BasecaBot's `PermissionLevel` enum:

| Value | Meaning |
|------:|---------|
| 0 | Viewer (regular chatter) |
| 1 | Subscriber |
| 2 | VIP |
| 3 | Moderator |
| 4 | Broadcaster |
| 5 | Admin (bot admin allowlist) |

**Authorization & limits are the app's responsibility.** The bot forwards *every* valid `!wheel` command regardless of who sent it. BasecaWheel decides, per `permission`:
- which actions each level may perform (e.g. maybe only `permission >= 3` can `title` or `spin`; anyone can `add`), and
- how many `add` submissions to accept per `user` (dedupe/limit by the `user` display name).

If the app rejects an action, it simply ignores it (and may optionally send an `announce` back to explain — see §4).

> **Note on followers:** the enum has no "follower" tier, and the bot cannot currently tell whether a chatter follows the channel from a chat message. Plain followers and non-followers both arrive as `0` (Viewer). If follower-gating is needed later, the bot will add a Helix lookup and this table will gain a value — design the app to treat unknown/other integers as "lowest privilege" so it stays forward-compatible.

---

## 4. Messages the app may SEND (wheel → bot) — optional

If you want the wheel to talk in chat, send either of these (both optional):

**Announce arbitrary text in chat:**
```json
{ "type": "announce", "room": "baseca-wheel", "payload": { "text": "Entry added! 🎉" } }
```
→ Bot posts `text` verbatim to chat.

**Announce a spin winner in chat:**
```json
{ "type": "result", "room": "baseca-wheel", "payload": { "winner": "SomeName" } }
```
→ Bot posts: `🎡 The wheel landed on SomeName!`

Any other `type` you send is ignored by the bot (logged at debug). You never *have* to send anything back — the wheel can be display-only.

---

## 5. Minimal reference client

```js
const SECRET = '...';           // must match the bot's WS_HUB_SECRET
const URL = `ws://localhost:8080?room=baseca-wheel&secret=${SECRET}`;

let ws;
function connect() {
  ws = new WebSocket(URL);
  ws.onopen = () => console.log('connected to BasecaBot');
  ws.onclose = () => setTimeout(connect, 2000); // simple auto-reconnect
  ws.onerror = () => {}; // a bad secret closes with code 4001
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type !== 'wheel') return;
    const { command, text, user, permission } = msg.payload;

    switch (command) {
      case 'title':
        if (permission >= 3) setWheelTitle(text);           // app's own rule
        break;
      case 'add':
        if (canUserAdd(user)) {                             // app's own per-user limit
          addEntry(text);
          send('announce', { text: `${user} added "${text}"` });
        }
        break;
      case 'spin':
        if (permission >= 3) {                              // app's own rule
          const winner = spinAndGetWinner();
          send('result', { winner });
        }
        break;
      case 'clear':
        clearEntriesFor(user);                              // remove only this user's entries
        break;
      case 'reset':
        if (permission >= 3) resetWheel();                  // wipe everything (managers only)
        break;
    }
  };
}

function send(type, payload) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type, room: 'baseca-wheel', payload }));
  }
}

connect();
```

Replace `setWheelTitle`, `addEntry`, `canUserAdd`, `spinAndGetWinner`, `clearEntriesFor`, `resetWheel` with BasecaWheel's real logic. The permission checks and per-user limits shown are examples — set them to whatever BasecaWheel wants. Note the intended distinction: **`clear` is scoped to the calling `user`'s own entries** (so it needs no permission gate), whereas **`reset` wipes the whole wheel** and should be gated on `permission`.

---

## 6. Quick manual test

1. Start the bot (`npm run dev`) with `WS_HUB_SECRET` set.
2. Connect BasecaWheel to `ws://localhost:8080?room=baseca-wheel&secret=<secret>`.
3. In Twitch chat: `!wheel title Movie Night`, `!wheel add Inception`, `!wheel add The Matrix`, then `!wheel spin`.
4. Confirm the app receives four `wheel` messages and (if implemented) the bot posts the winner via your `result` message.
5. Then test the new commands: `!wheel clear` (the caller's own entries disappear) and, as a mod, `!wheel reset` (the whole wheel empties).

You can validate all of this without the real app using the bundled harness at `webapps/baseca-wheel/index.html`, which implements this exact contract (including the `clear`/`reset` semantics above).
