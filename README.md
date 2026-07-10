# BasecaBot

An extensible Twitch bot. A thin **core kernel** hosts pluggable **features/modes/games**; it handles chat & commands, remembers users, runs a points economy, reacts to stream events (subs/bits/raids/follows/donations), and integrates with external **web apps** in real time over a WebSocket hub.

Runs locally on macOS today (SQLite, no infra) and migrates to an always-on server later by changing one env var (Postgres) and running the Docker image.

## Architecture at a glance

```
Twitch chat / EventSub ──▶ Adapters ──▶ EventBus ──▶ Plugins ──▶ Services (users, points, chat, storage)
                                              │
Web apps (games) ◀────── WebSocket hub ◀──────┘
```

- **Core** (`src/core/`): `eventBus`, `commandRouter`, `pluginManager`, `serviceContext`, canonical `events`.
- **Services** (`src/services/`): `users`, `points`, `chat`, `storage` (Prisma), `config`, `logger`.
- **Adapters** (`src/adapters/`): Twitch chat + EventSub (donation adapter is a future stub).
- **Plugins** (`src/plugins/`): `points`, `commands`, `events`, `sampleGame`, `basecaWheel`.
- **Web** (`src/web/wsHub.ts`): WebSocket hub for web apps. Companion demo in `webapps/sample-game/`.

**Adding a feature** = add a folder under `src/plugins/`, export a `Plugin`, and register it in `src/plugins/index.ts`. No kernel changes.

## Setup (local, macOS)

```bash
npm install
cp .env.example .env          # then fill in Twitch client id/secret + bot tokens
npm run prisma:migrate        # creates the SQLite DB (prisma/basecabot.db)
npm run dev                   # starts the bot with hot reload
```

Required Twitch setup (two accounts, two tokens):
1. Create an app at <https://dev.twitch.tv/console/apps> → `TWITCH_CLIENT_ID` / `TWITCH_CLIENT_SECRET`.
2. Get an OAuth access+refresh token for the **bot account** (BasecaBot) with scopes
   `chat:read chat:edit` → `TWITCH_BOT_ACCESS_TOKEN` / `TWITCH_BOT_REFRESH_TOKEN`.
3. Get an OAuth access+refresh token for the **broadcaster account** (your channel) with scopes
   `channel:read:subscriptions bits:read moderator:read:followers` →
   `TWITCH_BROADCASTER_ACCESS_TOKEN` / `TWITCH_BROADCASTER_REFRESH_TOKEN`.
   (Subs/bits/follows EventSub can only be authorized by the channel owner, hence the second token.)
4. Fill `TWITCH_CHANNELS`, `TWITCH_BROADCASTER_USERNAME`, and `BOT_ADMINS` in `.env`.

## Commands (out of the box)

| Command | Who | What |
| --- | --- | --- |
| `!points` / `!p` | everyone | Show your balance (`!points top` for leaderboard) |
| `!give <user> <n>` | everyone | Transfer points |
| `!addpoints <user> <n>` | mod | Grant/deduct points |
| `!command` (alias `!cmd`) | mod | Manage custom commands — `add`/`response`/`setgroup`/`cooldown`/`restrict`/`setcount`/`enable`/`disable`/`addalias`/`remove` on a `!trigger` or `"phrase"` |
| `!startgame` / `!endgame` / `!vote <x>` | mod / everyone | Sample web-app game |

## Try the web-app loop

1. Run the bot (`npm run dev`).
2. Open `webapps/sample-game/index.html` in a browser and click **Connect**
   (default URL uses `WS_HUB_SECRET=change-me`).
3. In chat: `!startgame`, then viewers `!vote red` / `!vote blue`. Votes appear live in the page.
4. Click **Declare winner** in the page → the bot announces the winner in chat and awards points.

## Testing

```bash
npm test          # unit tests (EventBus, CommandRouter)
npm run typecheck # tsc --noEmit
npm run lint
```

## Deploy to a server

Full walkthrough (DNS, HTTPS, first deploy, updates): **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)**.

In short, `docker-compose.yml` runs the bot as a **single container** on the shared external
`edge` Docker network. HTTPS/TLS and static web-app serving are handled by the separate
**`edge-server`** project (a host-wide Caddy that owns 80/443 and proxies `wss://bot.edmorex.com/ws`
to the hub — see [docs/edge-server-spec.md](docs/edge-server-spec.md)). Data lives on persistent
volumes (SQLite + refreshed tokens). On the server, with `.env` filled in and the `edge` network
created (`docker network create edge`):

```bash
docker compose up -d --build     # first deploy
./scripts/deploy.sh              # subsequent deploys (git pull + rebuild + restart)
```

## Roadmap / extension points

- Donation adapter (StreamElements/StreamLabs) emitting the existing `donation` event.
- Optional REST layer alongside the WebSocket hub for non-realtime apps.
- Channel-point redemptions plugin (EventSub already supports it).
- Whisper support (needs Helix API + user-token scopes).
