# Stream Deck & scripted control

The admin dashboard is a browser app that logs in with Twitch, which a Stream Deck
cannot do. So there is a second credential — the **control token**, managed from the
dashboard's **API Control** panel — that lets a button, a shell script or a phone
shortcut fire the **live controls** over plain HTTP.

Every button below is one `curl`, so anything you can bind you can also test from a
terminal first.

## Setup

Everything is in the dashboard under **API Control** — there is nothing to edit on
the server and no restart involved.

1. Open **API Control** in the admin dashboard.
2. Press **Generate**. The token is shown **once**; copy it into your Stream Deck
   or script now. (You can paste your own instead — 16 characters minimum, no
   spaces, since it travels in an HTTP header.)
3. Turn **API enabled** on.

The panel then shows which token is in place by its last four characters and when
it was last changed. It never shows the value again: regenerate if you lose it,
which also invalidates the old one immediately.

Send it as the **`X-Control-Token` header**. Never in a URL: query strings land in
access logs, in referrers and in anything that proxies the request, and the server
deliberately ignores a token offered that way.

### The master switch

**API enabled** is checked before the token and independently of it, so turning it
off refuses requests that carry a perfectly valid token — a panic button that does
not require you to rotate anything. It comes back the moment you switch it on, with
no restart. It governs the token path only; you can always still drive everything
from the dashboard yourself.

Removing the token closes the API too, however the switch is set. A fresh install
starts with the switch off and no token, so nothing is exposed until you decide.

## What it can do — and what it deliberately cannot

The token is accepted by exactly seven endpoints, listed below. It is **refused
everywhere else**, including saving settings, uploading or deleting images and
sounds, editing text strings, backfilling achievements and touching user accounts.
Those stay logged-in-only, so a token leaked in a Stream Deck profile or a synced
dotfile cannot rewrite your configuration or delete anybody.

That split is enforced per handler in `src/web/routes/adminRoutes.ts` (they call
`requireAdminOrControl` instead of `requireAdmin`) and pinned by tests in
`src/web/controlToken.test.ts`, so widening it takes a deliberate edit. The panel's
list comes from `CONTROL_ENDPOINTS` in `src/services/apiControl.ts`, and a test
asserts that list matches the handlers exactly — so what the panel shows you cannot
drift from what your token can actually do.

Note the one-segment difference that matters: `POST /api/admin/crowd/live` runs a
single live action and **is** reachable; `POST /api/admin/crowd` saves the whole
settings panel and **is not**.

## The commands

```bash
H="X-Control-Token: <the token you generated>"
J='content-type: application/json'
U=https://your-bot.example/api/admin
```

### Crowd Hype — live controls

```bash
# Excitement ceiling: hold the crowd at 4, keep 5 for the finale
curl -fsS -X POST $U/crowd/live -H "$H" -H "$J" -d '{"action":"max-level","level":4}'
curl -fsS -X POST $U/crowd/live -H "$H" -H "$J" -d '{"action":"max-level","level":5}'

# Slow mode (the lighters come up with it)
curl -fsS -X POST $U/crowd/live -H "$H" -H "$J" -d '{"action":"slow","seconds":30}'
curl -fsS -X POST $U/crowd/live -H "$H" -H "$J" -d '{"action":"slow-wait"}'

# Clear the overlay / hold everyone calm
curl -fsS -X POST $U/crowd/live -H "$H" -H "$J" -d '{"action":"clear","seconds":30}'
curl -fsS -X POST $U/crowd/live -H "$H" -H "$J" -d '{"action":"clear-wait"}'
curl -fsS -X POST $U/crowd/live -H "$H" -H "$J" -d '{"action":"quiesce","seconds":30}'
curl -fsS -X POST $U/crowd/live -H "$H" -H "$J" -d '{"action":"quiesce-wait"}'

# Lift any hold (does NOT lift the excitement ceiling - that is a setting)
curl -fsS -X POST $U/crowd/live -H "$H" -H "$J" -d '{"action":"resume"}'

# Simulated chat, for tuning without an audience
curl -fsS -X POST $U/crowd/live -H "$H" -H "$J" -d '{"action":"sim","on":true}'
```

Omit `seconds` and the hold uses the duration saved in the panel.

### Boss Battle

```bash
# Start a battle. bossId null picks at random; delaySeconds 0-120
curl -fsS -X POST $U/boss/start  -H "$H" -H "$J" -d '{"bossId":null,"delaySeconds":15}'
curl -fsS -X POST $U/boss/cancel -H "$H"

# Mock battle: full presentation, nothing recorded, no achievements
curl -fsS -X POST $U/boss/sim/spawn  -H "$H" -H "$J" -d '{"bossId":null}'
curl -fsS -X POST $U/boss/sim/action -H "$H" -H "$J" -d '{"action":"hit"}'   # hit|miss|heal|dupe
```

### Pet the Floof

```bash
# Spawn one. image/style null = random, as in the panel
curl -fsS -X POST $U/floof/fire -H "$H" -H "$J" -d '{"image":null,"style":null}'
# Simulate a !pet without writing to the database
curl -fsS -X POST $U/floof/simulate-pet -H "$H"
```

## Reading the responses

| Status | Means |
|---|---|
| 200 `{"ok":true}` | Done. Crowd live actions also return the new `live` state |
| 400 | Bad action name or argument — check for a typo |
| 401 | Wrong or missing token, **or** the endpoint does not accept tokens at all |
| 409 | The action cannot run right now (a battle is already active, no floof to pet) |
| 503 | The API is switched off, or no token has been set — check the panel |

`curl -fsS` exits non-zero on anything but success, which is all a button needs.

## Wiring it to a deck

Roughly in order of effort:

- **Bitfocus Companion**, Generic HTTP module — POST with a custom header,
  configured rather than coded.
- **A community HTTP-request plugin** for the Elgato app (BarRaider's suite is the
  usual recommendation).
- **`System: Open`** running a one-line script per button — the crudest option, and
  literally the `curl` you already tested.

A one-way button cannot *show* state, so there is no key that reads "capped at 4".
That is fine here because every live control is an explicit action rather than a
toggle: five ceiling buttons mirror the radio set in the panel, and "Slow for 30s",
"Slow until resume" and "Resume now" are separate actions. Put the buttons on the
deck in the same arrangement as the panel and the deck *is* the display.

## Security notes

- The token is a static secret, stored in the bot's database and in plaintext
  wherever your deck or script keeps it. Rotate it from the panel with
  **Generate** — the old one stops working at once, with no restart.
- Protect the database file as you would a credential store, since the token is
  readable there.
- It is compared in constant time, and a repeated or malformed header is refused
  rather than coerced.
- Requiring a custom header makes this path CSRF-safe by construction: a browser
  will not attach it to a cross-site request the way it attaches a cookie.
- If the bot is reachable from the internet, consider also restricting these paths
  by source IP at the Caddy layer — defence in depth on a shared secret.
- The overlay token (`OVERLAY_TOKEN`, still an env var) and the control token are
  separate on purpose. The overlay token
  stays read-only — it appears in OBS URLs and on screen during setup — and gains
  no write access; the control token is refused by the overlay endpoints in turn.
