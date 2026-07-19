# Moving BasecaBot to a new channel

Step-by-step for pointing the bot at a different broadcaster. Written for a new
broadcaster on **Windows with no Twitch CLI** — the token steps use only a
browser and PowerShell, both of which are already there.

Budget about 30 minutes. The bot is offline for roughly the last 5 of them.

> Deployment basics (server setup, Docker, the edge proxy) live in
> **[DEPLOYMENT.md](DEPLOYMENT.md)**. This doc only covers what a channel change
> touches.

---

## Three separate roles — don't conflate them

The single biggest source of confusion here is that "who owns the Twitch app",
"who runs the bot", and "whose channel it's in" are **three unrelated things**.
Only the last one is changing.

| Role | Account | Changing? | What it means |
|---|---|---|---|
| **Developer** (app owner) | `edmorex` | **No** | Owns the app at dev.twitch.tv, holds the client id + secret, configures redirect URIs. |
| **Bot admin** | `edmorex` | **No** | Full dashboard access via `BOT_ADMINS`. See the note in [Step 4](#step-4--update-the-server-env). |
| **Bot account** | `basecab0t` | **No** | The account that posts in chat. |
| **Broadcaster** | `edmorex` → **`basecampfoster`** | **Yes** | The channel the bot joins, and whose subs/bits/follows it reacts to. |

Consequences worth stating plainly:

- **You do not create or transfer a Twitch app.** `edmorex`'s existing app keeps
  working. Any Twitch account can authorize against any app — app ownership and
  the authorizing account are independent.
- **`basecampfoster` never visits dev.twitch.tv.** Their entire involvement is
  clicking *Authorize* on one consent screen and typing `/mod basecab0t` in their
  chat.
- **The domain doesn't change.** `bot.edmorex.com` stays, because it belongs to
  the person running the bot, not the broadcaster. The dashboard redirect URI is
  untouched.
- **`edmorex` keeps admin, but for a different reason.** Today they're admin
  twice over — as the broadcaster *and* via `BOT_ADMINS`. After the move only the
  `BOT_ADMINS` entry holds it up, so it must stay.

### Who does which step

| Step | `edmorex` (developer) | `basecampfoster` (new broadcaster) |
|---|---|---|
| 1. Redirect URI | ✅ | — |
| 2. Mod the bot | — | ✅ (`/mod basecab0t`) |
| 3a. Build authorize URL | ✅ (has the client id) | — |
| 3b–3c. Approve + copy code | — | ✅ (signed in as themselves) |
| 3d–3e. Exchange + validate | ✅ (has the client secret) | — |
| 4–8. Server, restart, verify | ✅ | — |

See [Doing Step 3 with two people](#doing-step-3-with-two-people) for how to hand
the code over — it's time-sensitive.

---

## What actually changes

| | Changes? | Why |
|---|---|---|
| `TWITCH_BROADCASTER_USERNAME` | **Yes** | This one value sets the channel the bot joins — `config.twitch.channel` is derived from it. |
| Broadcaster access + refresh token | **Yes** | EventSub scopes (subs, bits, follows) can only be granted by the channel owner. |
| `BOT_ADMINS` | No — but now load-bearing | `edmorex` stops being an automatic admin (that came from being broadcaster) and keeps access only via this list. |
| Persisted `.tokens/broadcaster.json` | **Must be deleted** | It overrides `.env`. See [Step 5](#step-5--delete-the-persisted-broadcaster-token). |
| Bot account + its tokens | No | `chat:read`/`chat:edit` aren't channel-specific. The bot account just needs modding in the new channel. |
| Twitch app (client id/secret) | No | `edmorex`'s app serves any channel. You only **add** a redirect URI. |
| Domain / `PUBLIC_URL` | No | `bot.edmorex.com` belongs to whoever runs the bot, not the broadcaster. |
| Database contents | Your call | See [Step 6](#step-6--decide-what-happens-to-the-data). |

---

## Before you start — three decisions

1. **Same bot account?** This guide assumes yes. If the bot account also changes,
   see [Changing the bot account too](#appendix--changing-the-bot-account-too).
2. **Keep or wipe the data?** Points, quotes, commands, and users all belong to
   the old channel. See [Step 6](#step-6--decide-what-happens-to-the-data).
3. **Same dashboard URL?** For this move, yes — `bot.edmorex.com` stays, since it
   belongs to `edmorex`, not the broadcaster. Only pursue a new domain if you
   specifically want one; that means DNS, a certificate, and edge-server changes
   (DEPLOYMENT.md Parts A and I).

You will need: the Twitch **client id and secret** (from `edmorex`'s app at
<https://dev.twitch.tv/console/apps>), SSH access to the server, and
`basecampfoster` at their PC to click through one authorization page.

---

## Step 1 — Register a redirect URI for token generation

> **Done by `edmorex`, on the existing app.** No new app, no transfer of
> ownership, and `basecampfoster` is not involved in this step at all.

A redirect URI is a property of **the app**, not of the account being
authorized. Adding one here lets *any* Twitch account — including
`basecampfoster` — complete an authorization that hands the code back to a
local address you control.

1. Sign in to <https://dev.twitch.tv/console/apps> **as `edmorex`**.
2. Find the existing BasecaBot app → **Manage**.
3. Under **OAuth Redirect URLs**, click **Add** and enter exactly:

   ```
   http://localhost:3000
   ```

4. **Save** (easy to miss — the button is at the bottom).

Twitch allows plain `http` for `localhost` specifically; it won't accept it for
any other host.

### What this URL is and isn't

- It is **not** a server you have to run. Nothing listens on port 3000.
- After approving, the browser shows *"This site can't be reached"*. **That is
  the expected outcome.** The value is in the address bar: `?code=...`.
- It is not the dashboard login URL. That's a separate entry.

### Your app should end up with two redirect URIs

| URI | Purpose | Used by |
|---|---|---|
| `https://bot.edmorex.com/auth/callback` | Dashboard "Login with Twitch" | Everyone who logs into the dashboard |
| `http://localhost:3000` | One-off token generation (this doc) | Only during Step 3 |

**Leave the existing dashboard entry alone.** An app can hold several, and
deleting that one breaks dashboard logins for everybody. You're adding, not
replacing.

While you're on this page, copy the **Client ID**, and use **New Secret** if you
don't still have the client secret — you need both in Step 3.

> Generating a new secret invalidates the old one. The running bot reads its
> secret from the server `.env`, so if you regenerate, update
> `TWITCH_CLIENT_SECRET` there too or the bot will fail to refresh tokens.

---

## Step 2 — Mod the bot in the new channel

> **Done by `basecampfoster`.** This is one of only two things they need to do.

In their own chat, `basecampfoster` types:

```
/mod basecab0t
```

Without this the bot still talks, but it's subject to strict rate limits and
can't moderate.

---

## Step 3 — Get new broadcaster tokens (Windows, no CLI)

The token must be authorized **by `basecampfoster`**, because only the channel
owner can grant scopes like `channel:read:subscriptions`. But the exchange in 3d
needs the **client secret**, which belongs to `edmorex`. So the two halves are
usually done by two different people.

### Doing Step 3 with two people

The `code` from 3c expires in a few minutes and is single-use, so plan the
handoff before you start. Two workable shapes:

- **Relay (keeps the secret with `edmorex`)** — `edmorex` sends the authorize URL
  from 3a; `basecampfoster` approves and pastes the `code` straight back over
  chat/Discord; `edmorex` immediately runs 3d. Be on a call or actively watching
  messages so the code doesn't go stale. If it expires, just redo 3a–3c.
- **Screen share** — `basecampfoster` shares their screen and `edmorex` walks
  them through all of 3a–3e on their PC. Simpler, but the client secret gets
  typed on `basecampfoster`'s machine, so only do this if that's acceptable.

Either way `basecampfoster` never needs the client secret to *approve* — only to
*exchange*. The authorize URL contains just the public client id.

### 3a. Build the authorization URL

Take the URL below and replace `YOUR_CLIENT_ID`. Everything else is already
URL-encoded — paste it as one line:

```
https://id.twitch.tv/oauth2/authorize?client_id=YOUR_CLIENT_ID&redirect_uri=http://localhost:3000&response_type=code&force_verify=true&scope=channel%3Aread%3Asubscriptions+bits%3Aread+moderator%3Aread%3Afollowers+moderation%3Aread+moderator%3Aread%3Achatters+channel%3Aread%3Avips
```

Those six scopes are the full set the bot uses. What each one buys you is
documented in DEPLOYMENT.md § I2 — the one worth knowing is
`moderator:read:chatters`, **without which no points are ever awarded**.

### 3b. Approve as `basecampfoster`

> **Open this in a private/incognito window.** Otherwise you'll authorize
> whichever account the browser is already signed into — the single most common
> way this goes wrong. If `edmorex` opens the link on their own machine while
> signed in, they'll silently mint another `edmorex` token and nothing will
> change. `force_verify=true` forces the prompt, but it can't pick the account.

1. Sign in **as `basecampfoster`**.
2. Confirm the consent screen names `basecampfoster` — not `edmorex`, not
   `basecab0t`.
3. Click **Authorize**.

### 3c. Copy the code

The browser lands on a dead page. Copy the `code` value out of the address bar:

```
http://localhost:3000/?code=abc123def456...&scope=channel%3Aread...
                            ^^^^^^^^^^^^^^^ just this part, up to the &
```

**This code is single-use and expires in a few minutes.** Do Step 3d right away;
if it fails, just redo 3a–3c for a fresh one.

### 3d. Exchange the code for tokens (PowerShell)

Open PowerShell and run, substituting the three values:

```powershell
$body = @{
  client_id     = 'YOUR_CLIENT_ID'
  client_secret = 'YOUR_CLIENT_SECRET'
  code          = 'PASTE_THE_CODE_HERE'
  grant_type    = 'authorization_code'
  redirect_uri  = 'http://localhost:3000'
}
Invoke-RestMethod -Method Post -Uri 'https://id.twitch.tv/oauth2/token' -Body $body | ConvertTo-Json
```

You get back:

```json
{
  "access_token": "xxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  "refresh_token": "yyyyyyyyyyyyyyyyyyyyyyyyyyyy",
  "expires_in": 14124,
  "scope": ["channel:read:subscriptions", "bits:read", "..."],
  "token_type": "bearer"
}
```

Keep both tokens. Treat them like passwords — anyone holding them can act as the
broadcaster.

### 3e. Verify before you go further

This 10-second check catches the wrong-account mistake before it costs you a
deploy:

```powershell
Invoke-RestMethod -Uri 'https://id.twitch.tv/oauth2/validate' `
  -Headers @{ Authorization = 'OAuth PASTE_ACCESS_TOKEN' } | ConvertTo-Json
```

Confirm that:

- `login` is the **new broadcaster's** username.
- `scopes` lists **all six** from Step 3a.

If `login` is wrong, redo Step 3b in a private window. If scopes are missing,
the authorize URL was truncated — redo 3a.

---

## Step 4 — Update the server `.env`

```bash
ssh you@your-server
cd ~/BasecaBot
cp .env .env.bak          # rollback insurance
nano .env
```

Change these three:

```dotenv
TWITCH_BROADCASTER_USERNAME=basecampfoster
TWITCH_BROADCASTER_ACCESS_TOKEN=<access_token from 3d>
TWITCH_BROADCASTER_REFRESH_TOKEN=<refresh_token from 3d>
```

`TWITCH_BROADCASTER_USERNAME` is the account **login** (lowercase, as it appears
in `twitch.tv/<login>`), not the display name.

### Leave `BOT_ADMINS` as it is — but understand why

```dotenv
BOT_ADMINS=edmorex
```

Right now this line is redundant: `edmorex` is an admin twice over, as the
broadcaster *and* as a listed admin (the broadcaster is always added to the admin
list automatically). After this change `basecampfoster` becomes the automatic
admin, and **this line is the only thing keeping `edmorex`'s access**.

So: don't "tidy it up", and don't replace it with `basecampfoster` — that name is
added for free. Add any additional admins here as a comma-separated list.

Everything else stays untouched — bot tokens, `TWITCH_CLIENT_ID`/`SECRET`,
`PUBLIC_URL`, `DATABASE_URL`, `WS_HUB_SECRET`.

---

## Step 5 — Delete the persisted broadcaster token

**Do not skip this.** On startup the bot reads `.tokens/broadcaster.json` and
uses it **in preference to `.env`** — the `.env` values are only a first-run
seed. Twitch rotates refresh tokens, so the persisted copy is normally the only
current one. Edit `.env` without clearing this file and the bot silently keeps
authenticating as the **old** broadcaster.

```bash
docker compose exec bot rm -f /app/.tokens/broadcaster.json
```

If the container isn't running, reach the volume directly instead:

```bash
docker run --rm -v basecabot_bottokens:/t alpine rm -f /t/broadcaster.json
```

> **Delete only `broadcaster.json`.** Do not `docker volume rm basecabot_bottokens`
> — that also destroys `bot.json`, and if the bot's refresh token in `.env` has
> since rotated, the bot can no longer authenticate to chat at all. Removing the
> whole volume is only safe when *both* `.env` token pairs are freshly generated
> (see the [appendix](#appendix--changing-the-bot-account-too)).

---

## Step 6 — Decide what happens to the data

### Option A — Keep everything (default)

Change nothing. Points balances, quotes, custom commands, lists, and user records
carry over from the old channel. Sensible if the same community is moving.

### Option B — Start fresh

A clean slate for a new community. **Irreversible.**

```bash
cd ~/BasecaBot
docker compose cp bot:/data/basecabot.db ./basecabot-backup-$(date +%F).db   # keep a copy
docker volume ls | grep botdata            # confirm the exact name first
docker compose down
docker volume rm basecabot_botdata
```

The database is recreated and migrated automatically on the next start.

Survives a wipe: Twitch tokens (separate volume), `.env`, and `BOT_ADMINS`.
Lost: all points, quotes, commands, lists, users, custom display names and
aliases, and any dashboard-edited settings.

If you're restoring content afterwards, export the CSVs from the Commands /
Lists / Quotes pages **before** wiping, and see
[user-accounts.md](user-accounts.md) — quote imports reference users by Twitch id,
so create those accounts via **Admin → Users → Init New User** *before* importing,
or the links silently degrade to plain name snapshots.

---

## Step 7 — Restart and verify

```bash
cd ~/BasecaBot
docker compose up -d --build
docker compose logs -f bot
```

Expect to see, within a few seconds:

```
starting BasecaBot   { channel: 'basecampfoster' }
chat connected
EventSub listening
HTTP server listening
```

Then check, in order:

| Check | How | Expected |
|---|---|---|
| Right channel | The `starting BasecaBot` log line | Shows `basecampfoster` |
| Chat works | Type `!points` in the new channel | The bot replies |
| Broadcaster identity | `basecampfoster` logs into the dashboard | **Admin** appears in the nav |
| Developer kept access | `edmorex` logs into the dashboard | **Admin** still appears — proves `BOT_ADMINS` held |
| Admin rights | Open `/admin` | Users table loads (not a redirect home) |
| Scopes took | `/admin` → Users → Permission column | Mods/VIPs/subs show real roles, not all "Everyone" |
| EventSub | `/admin` → EventSimulator → fire a Follow | Bot posts the follow message in chat |
| Payouts | Wait ~5 min with chat active, then `!points` | Balance increases |

The Permission column and the payout check are the two that specifically prove
the new **scopes** work — everything else would pass on an under-scoped token.

---

## Step 8 — Tidy up

- In the **old** channel (`edmorex`): `/unmod basecab0t` if the bot is done there.
- `edmorex` can revoke the bot's old broadcaster authorization at
  <https://www.twitch.tv/settings/connections>. Do this **after** verifying, and
  note it does not affect their dashboard admin access, which comes from
  `BOT_ADMINS`.
- Optionally remove the `http://localhost:3000` redirect URI from the app — it's
  only needed while generating tokens.
- Delete `.env.bak` once you're satisfied (it contains live secrets).
- Update `TWITCH_BROADCASTER_USERNAME=basecampfoster` in your **local** `.env`
  too, so local dev points at the same channel.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Bot still posts in the **old** channel | `.tokens/broadcaster.json` still present | [Step 5](#step-5--delete-the-persisted-broadcaster-token), then restart |
| `invalid authorization code` | Code expired or already used | Redo Steps 3a–3d; codes are single-use |
| `redirect_uri` mismatch | URI not registered, or not character-identical | Step 1 — no trailing slash, exact port |
| Validate shows the wrong `login` | Authorized as the wrong account | Redo 3b in a private window |
| Bot silent in chat | Bot token invalid, or bot not modded | `docker compose logs bot`; re-mod; check `bot.json` wasn't deleted |
| No points awarded | `moderator:read:chatters` missing | Re-run Step 3 with the full scope list |
| Everyone shows "Everyone" in Admin → Users | `moderation:read` / `channel:read:vips` missing | Same |
| Dashboard login loops | `PUBLIC_URL` ≠ the registered redirect URI | Match them exactly (DEPLOYMENT.md § I3) |
| No subs/bits/follow reactions | EventSub couldn't subscribe with this token | Check logs at startup; verify broadcaster scopes |

---

## Rollback

If the old broadcaster's tokens are still valid:

```bash
cd ~/BasecaBot
cp .env.bak .env
docker compose exec bot rm -f /app/.tokens/broadcaster.json
docker compose up -d --build
```

If you wiped the database in Step 6, restore the backup you copied out:

```bash
docker compose down
docker run --rm -v basecabot_botdata:/d -v "$PWD":/b alpine \
  sh -c 'cp /b/basecabot-backup-YYYY-MM-DD.db /d/basecabot.db'
docker compose up -d
```

---

## Appendix — changing the bot account too

Same flow, different scopes and file:

1. Register the bot's new account and mod it in the new channel.
2. Run Step 3 signed in **as the new bot account**, with
   `scope=chat%3Aread+chat%3Aedit`.
3. Set `TWITCH_BOT_USERNAME`, `TWITCH_BOT_ACCESS_TOKEN`,
   `TWITCH_BOT_REFRESH_TOKEN` in `.env`.
4. Delete the persisted **bot** token:
   `docker compose exec bot rm -f /app/.tokens/bot.json`
5. Restart and verify chat.

Changing both accounts at once is the one case where removing the whole
`basecabot_bottokens` volume is safe, since both `.env` seeds are fresh.
