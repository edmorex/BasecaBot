# Deploying BasecaBot to a VPS

This guide takes BasecaBot from your laptop to your always-on IONOS Ubuntu server, behind HTTPS, and explains how to keep developing locally and ship future updates.

- **Server:** IONOS VPS, Ubuntu 24.04, `198.251.74.112`
- **Domain:** `bot.edmorex.com`
- **Runtime:** Docker Compose — the bot runs as a **single container** behind a separate, host-wide edge proxy.

> **TLS/HTTPS now lives in the `edge-server` project**, not here. A dedicated Caddy in that project owns ports 80/443, terminates TLS for all domains, serves the web apps, and proxies `wss://bot.edmorex.com/ws` to this bot over the shared external `edge` Docker network. This project just runs the bot + WebSocket hub. See `docs/edge-server-spec.md` for the edge side.

```
                Internet  :443 / :80
                   │
          ┌────────▼─────────┐   edge-server project (separate compose stack)
          │   caddy (edge)   │   TLS for all domains + static apps + wss proxy
          └────────┬─────────┘
                   │ shared external docker network "edge"
          ┌────────▼─────────┐   THIS project (docker-compose.yml)
          │      bot         │   bot process + WebSocket hub (:8080, not public)
          │                  │   SQLite on a persistent volume
          └──────────────────┘
```

Why this shape:
- **One edge Caddy** owns 80/443 for the whole host and gives automatic HTTPS. The bot's hub port `8080` is never exposed to the internet — only the edge Caddy reaches it, over the private `edge` network.
- **EventSub runs over WebSocket** (outbound from the bot), so you do **not** need any public webhook URL. HTTPS is only for serving web apps and the secure `wss` the browsers need.
- **SQLite on a Docker volume** keeps the server simple — one bot process doesn't need Postgres. (Upgrading to Postgres later is covered at the end.)
- **DNS, the firewall, and cert issuance are handled once, in `edge-server`** (Part A below is the original single-stack setup — most of it is already done; the DNS record for `bot` and the firewall ports remain relevant).

---

## Part A — One-time server setup

### A1. Point your domain at the server (do this first — DNS takes time to propagate)

In the **IONOS control panel** → your domain → **DNS settings**:

| Type | Host name | Value / Points to | TTL |
|------|-----------|-------------------|-----|
| `A`  | `@` (or a subdomain like `bot`) | `198.251.74.112` | 1 hour |

Use a subdomain (e.g. `bot.example.com` → host `bot`) if you want the root domain for something else. Verify propagation:

```bash
dig +short bot.example.com     # should print 198.251.74.112
```

Wait until this resolves before running the deploy, or Caddy can't get a certificate.

### A2. Log in and create a non-root user (recommended)

```bash
ssh root@198.251.74.112

adduser baseca
usermod -aG sudo baseca
# copy your SSH key to the new user (from your laptop, or set a password login)
rsync --archive --chown=baseca:baseca ~/.ssh /home/baseca
```

Then log in as that user going forward: `ssh baseca@198.251.74.112`.

### A3. Install Docker Engine + Compose plugin

```bash
sudo apt update && sudo apt upgrade -y
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker "$USER"      # run docker without sudo
newgrp docker                        # apply the group now (or log out/in)
docker --version && docker compose version
```

### A4. Firewall

Open only SSH + HTTP + HTTPS. The hub port stays private.

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
sudo ufw status
```

> **Also check the IONOS Cloud Panel firewall** for the VPS — IONOS applies its own network firewall in front of the server. Make sure inbound TCP **22, 80, 443** are allowed there too, or Let's Encrypt/HTTPS will silently fail even with ufw open.

---

## Part B — First deploy

### B1. Give the server read access to your GitLab repo

Generate a key on the **server** and add it to GitLab as a read-only **Deploy Key**:

```bash
ssh-keygen -t ed25519 -C "baseca-vps" -f ~/.ssh/id_ed25519 -N ""
cat ~/.ssh/id_ed25519.pub
```

Copy that public key → GitLab → your project → **Settings → Repository → Deploy keys** → add it (read-only is fine). Then clone:

```bash
cd ~
git clone git@gitlab.com:<you>/basecabot.git
cd basecabot
```

### B2. Create the server `.env`

`.env` is git-ignored — it never leaves your machines. Create it on the server:

```bash
cp .env.example .env
nano .env
```

Fill in, at minimum:

| Variable | Value |
|----------|-------|
| `TWITCH_CLIENT_ID` / `TWITCH_CLIENT_SECRET` | from your Twitch app |
| `TWITCH_BOT_USERNAME` | `basecabot` |
| `TWITCH_BOT_ACCESS_TOKEN` / `TWITCH_BOT_REFRESH_TOKEN` | bot-account token pair |
| `TWITCH_BROADCASTER_USERNAME` | your channel login (the single channel the bot runs in) |
| `TWITCH_BROADCASTER_ACCESS_TOKEN` / `TWITCH_BROADCASTER_REFRESH_TOKEN` | broadcaster-account token pair |
| `BOT_ADMINS` | your login |
| `WS_HUB_SECRET` | a long random string (`openssl rand -hex 24`) |
| `DOMAIN` | `bot.example.com` |
| `ACME_EMAIL` | your email (for cert notices) |
| `EVENT_SIM_ENABLED` | **leave blank** in production |

Leave `DATABASE_URL` as-is — Compose overrides it to the volume path (`file:/data/basecabot.db`) inside the container.

> The tokens can be the **same** ones you generated for local dev — they aren't tied to a machine. But see [Part C](#part-c--local-development) about not running both at once.

### B3. Launch

The bot joins the shared `edge` network (created by the `edge-server` project). Make sure that network exists (`docker network create edge`), then:

```bash
docker compose up -d --build
```

First run will: build the image, run `prisma migrate deploy` (creates the SQLite DB on the volume), and start the bot on the `edge` network. The `edge-server` Caddy proxies `wss://bot.edmorex.com/ws` to it and serves the web apps — see `docs/edge-server-spec.md` §7 for the one-time edge wiring (uncomment the `bot.edmorex.com` block, mount this repo's `webapps/`).

### B4. Verify

```bash
docker compose ps                    # bot "running"
docker compose logs -f bot           # look for "chat connected" and "EventSub listening"
```

Then:
- Visit `https://bot.edmorex.com/` → "BasecaBot is running." with a valid padlock (served by the edge Caddy).
- Visit `https://bot.edmorex.com/wheel/` → the BasecaWheel harness loads; click Connect (the URL auto-fills `wss://bot.edmorex.com/ws?...` — just set the secret to your `WS_HUB_SECRET`).
- In your Twitch chat, type `!points` → the bot replies.

Deployment done. 🎉

---

## Part C — Local development

Nothing about local dev changes. On your laptop:

```bash
npm install
npm run dev            # tsx watch, SQLite at prisma/basecabot.db
```

Open the web apps as local files (`file://…/webapps/<app>/index.html`) — over `file://`/`http` they default to `ws://localhost:8080`, so no proxy is needed locally.

### ⚠️ Don't run local + server against the same Twitch account at the same time

Both instances would join chat as BasecaBot and **both** would respond to every command and event — duplicate messages, double point payouts — and they'd fight over Twitch token refreshes. Pick one:

- **Simplest:** only run `npm run dev` when the server bot is stopped (`docker compose stop bot` on the server), or when you simply aren't live.
- **Cleanest:** create a **separate dev bot account + Twitch app** and a private test channel, and keep a `.env.dev` for local use. Then local and prod are fully independent.

The database and refreshed tokens are per-environment (your laptop's `prisma/` + `.tokens/` vs. the server's Docker volumes), so they never collide — only the shared Twitch identity does.

---

## Part D — Future deployments

Your normal loop:

```bash
# on your laptop
git add -A && git commit -m "…" && git push

# on the server
cd ~/basecabot
./scripts/deploy.sh          # git pull + docker compose up -d --build + tail logs
```

`scripts/deploy.sh` rebuilds and restarts; **Prisma migrations apply automatically** on start (`prisma migrate deploy`). When you change the schema, generate the migration locally first:

```bash
npm run prisma:migrate -- --name <change>   # creates prisma/migrations/… ; commit it
```

Because the migration files are committed and baked into the image, `deploy.sh` applies them on the server with no extra step.

---

## Part E — Operations

**Logs**
```bash
docker compose logs -f bot      # bot
docker compose logs -f caddy    # TLS / proxy issues
```

**Restart / stop / start**
```bash
docker compose restart bot
docker compose stop
docker compose up -d
```

**Back up the database**
```bash
./scripts/backup-db.sh          # writes backups/basecabot-<timestamp>.db
```
Copy those off-server periodically (e.g. `scp` to your laptop, or a cron job).

**Rotating Twitch tokens.** The bot refreshes access tokens automatically and persists them to the `bottokens` volume, so it keeps working across restarts. You only need to touch tokens again if you **revoke** them or **change scopes** — then update `.env` and `docker compose up -d --build`. (To force a clean re-seed from `.env`, remove the token volume: `docker compose down && docker volume rm basecabot_bottokens`.)

**Updating the web apps only.** They're bind-mounted into Caddy from `./webapps`, so a `git pull` picks up changes; run `docker compose restart caddy` if needed.

---

## Part F — Troubleshooting

| Symptom | Likely cause / fix |
|---------|--------------------|
| No HTTPS cert / Caddy errors in logs | DNS not pointing at the server yet, or port 80/443 blocked (check **both** ufw and the IONOS Cloud Panel firewall). Caddy needs 80 reachable for the ACME challenge. |
| Web app connects but immediately closes with code **4001** | `secret` in the URL doesn't match `WS_HUB_SECRET`. |
| Close code **4002** | Missing `room` in the URL. |
| Bot doesn't post in chat | Bot-account token missing/invalid, or the bot/broadcaster tokens are swapped. Check `docker compose logs bot`. |
| No sub/bits/follow reactions | Broadcaster token missing the read scopes (`channel:read:subscriptions bits:read moderator:read:followers`). |
| Duplicate bot messages | A second instance is running (local **and** server) — see Part C. |

---

## Part G — CI/CD auto-deploy (GitHub Actions)

`.github/workflows/deploy.yml` runs the test suite on every push to `main` and, if it passes,
SSHes into the VPS and runs `scripts/deploy.sh`. One-time setup:

### G1. Create a dedicated deploy SSH key (on your laptop)

```bash
ssh-keygen -t ed25519 -f ~/.ssh/basecabot_deploy -N "" -C "github-actions-deploy"
```

### G2. Authorize it on the server

Append the **public** key to the server user's `authorized_keys`:

```bash
ssh-copy-id -i ~/.ssh/basecabot_deploy.pub ebures@198.251.74.112
# or manually: cat ~/.ssh/basecabot_deploy.pub | ssh ebures@198.251.74.112 'cat >> ~/.ssh/authorized_keys'
```

### G3. Point the server's repo at GitHub

The server may still have the old GitLab remote. Update it (public repo → HTTPS pull needs no auth):

```bash
ssh ebures@198.251.74.112
cd ~/BasecaBot
git remote set-url origin https://github.com/edmorex/BasecaBot.git
git pull    # confirm it works
```

### G4. Add GitHub repo secrets

Repo → **Settings → Secrets and variables → Actions → New repository secret**:

| Secret | Value |
|--------|-------|
| `SSH_HOST` | `198.251.74.112` (or `bot.edmorex.com`) |
| `SSH_USER` | `ebures` |
| `SSH_PRIVATE_KEY` | contents of `~/.ssh/basecabot_deploy` (the **private** key, whole file) |
| `SSH_KNOWN_HOSTS` | output of `ssh-keyscan bot.edmorex.com` (pins the server's host key) |

> `SSH_KNOWN_HOSTS` avoids host-key prompts *and* protects against a man-in-the-middle on the runner. Generate it with `ssh-keyscan bot.edmorex.com` (or the IP) and paste the output.

### G5. Done

Push to `main` → the **Actions** tab shows *Test* then *Deploy to VPS*. Deploy only runs if tests pass.
You can also trigger it manually from the Actions tab (**Run workflow**). Manual `./scripts/deploy.sh`
on the server still works anytime.

> **Future upgrade — build in CI, not on the server.** For faster/safer deploys, build the image in
> the workflow, push it to GitHub Container Registry (GHCR), and have the server `docker compose pull`
> instead of `--build`. More setup (registry auth + compose `image:` instead of `build:`); worth it if
> server builds get slow. The current build-on-server flow is fine to start.

---

## Part I — Web dashboard ("Login with Twitch")

The bot runs an HTTP server (port `HTTP_PORT`, default `8090`) serving the `bot.edmorex.com`
landing page, the OAuth flow, and a small JSON API. Wiring it up is four steps:

### I1. Register the OAuth redirect URI (Twitch console)

<https://dev.twitch.tv/console/apps> → your app → **OAuth Redirect URLs** → add:

```
https://bot.edmorex.com/auth/callback
```

(Keep the existing `http://localhost:3000` for token generation; an app can have several.)

### I2. Broadcaster-token scopes (dashboard + points payouts)

A few Helix features need scopes on the **broadcaster** token beyond the EventSub read scopes.
Regenerate the broadcaster token with the full set:

```
channel:read:subscriptions bits:read moderator:read:followers moderation:read moderator:read:chatters channel:read:vips
```

- `moderation:read` — dashboard's **Moderator** row (without it, that row just shows false).
- `moderator:read:chatters` — **required for point payouts.** The points plugin lists everyone
  connected to chat (incl. lurkers) every 5 min via Get Chatters; without this scope the call
  throws and **no points are awarded**.
- `channel:read:vips` — lets VIPs (who aren't also subs/mods) get the higher 30-point tier;
  without it they fall back to the 25-point tier.

Update `TWITCH_BROADCASTER_ACCESS_TOKEN` / `TWITCH_BROADCASTER_REFRESH_TOKEN`, then clear the token
cache so the new token is used: `docker compose down && docker volume rm basecabot_bottokens && docker compose up -d`.

### I3. Set the web env vars (server `.env`)

```dotenv
PUBLIC_URL=https://bot.edmorex.com
SESSION_SECRET=<openssl rand -hex 32>
# HTTP_PORT=8090   # default; only set to override
```

`PUBLIC_URL` must exactly match the domain in the redirect URI. `SESSION_SECRET` keeps logins valid
across restarts (if unset, an ephemeral one is generated and users re-login after each deploy).

### I4. Point Caddy at the HTTP server (edge-server project)

In the `edge-server` `Caddyfile`, the `bot.edmorex.com` block's catch-all `handle` must proxy to the
bot's HTTP server instead of returning a static string. Replace:

```caddyfile
	handle {
		respond "BasecaBot is running." 200
	}
```

with:

```caddyfile
	# Dashboard, OAuth, and JSON API (everything not matched above).
	handle {
		reverse_proxy bot:8090
	}
```

Leave the `/ws`, `/wheel`, `/sample`, `/events` blocks as they are — they're matched first. Then
`docker compose up -d` in `edge-server` to reload.

Verify: visit `https://bot.edmorex.com/` → "Login with Twitch" → after authorizing you're back on the
page showing your avatar, name, and the permission grid.

---

## Part H — Optional: Postgres instead of SQLite

**Postgres instead of SQLite.** For higher write volume or multiple bot processes:
1. Change `provider` in `prisma/schema.prisma` to `postgresql`.
2. Delete `prisma/migrations/` and regenerate against Postgres (`prisma migrate dev`), or use `prisma migrate diff`.
3. Add a `postgres` service to `docker-compose.yml` and set `DATABASE_URL` to it.

Not needed for a single always-on bot — SQLite on the volume is plenty.
