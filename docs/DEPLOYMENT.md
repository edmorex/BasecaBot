# Deploying BasecaBot to a VPS

This guide takes BasecaBot from your laptop to your always-on IONOS Ubuntu server, behind HTTPS, and explains how to keep developing locally and ship future updates.

- **Server:** IONOS VPS, Ubuntu 24.04, `198.251.74.112`
- **Domain:** your IONOS-registered domain (referred to below as `bot.example.com`)
- **Runtime:** Docker Compose — two containers:

```
                Internet
                   │  :443 / :80
            ┌──────▼───────┐   TLS + static web apps + wss proxy
            │    caddy     │   (auto Let's Encrypt cert for your domain)
            └──────┬───────┘
                   │ private docker network
            ┌──────▼───────┐   bot process + WebSocket hub (:8080, NOT public)
            │     bot      │   SQLite on a persistent volume
            └──────────────┘
```

Why this shape:
- **Caddy** gives you automatic HTTPS with zero cert wrangling, serves the web apps, and proxies `wss://` to the hub. The hub port `8080` is never exposed to the internet.
- **EventSub runs over WebSocket** (outbound from the bot), so you do **not** need any public webhook URL. HTTPS here is only for serving web apps and the secure `wss` the browsers need.
- **SQLite on a Docker volume** keeps the server simple — one bot process doesn't need Postgres. (Upgrading to Postgres later is covered at the end.)

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
| `TWITCH_CHANNELS`, `TWITCH_BROADCASTER_USERNAME` | your channel login |
| `TWITCH_BROADCASTER_ACCESS_TOKEN` / `TWITCH_BROADCASTER_REFRESH_TOKEN` | broadcaster-account token pair |
| `BOT_ADMINS` | your login |
| `WS_HUB_SECRET` | a long random string (`openssl rand -hex 24`) |
| `DOMAIN` | `bot.example.com` |
| `ACME_EMAIL` | your email (for cert notices) |
| `EVENT_SIM_ENABLED` | **leave blank** in production |

Leave `DATABASE_URL` as-is — Compose overrides it to the volume path (`file:/data/basecabot.db`) inside the container.

> The tokens can be the **same** ones you generated for local dev — they aren't tied to a machine. But see [Part C](#part-c--local-development) about not running both at once.

### B3. Launch

```bash
docker compose up -d --build
```

First run will: build the image, run `prisma migrate deploy` (creates the SQLite DB on the volume), start the bot, and start Caddy — which requests a TLS certificate for `DOMAIN`. Give it ~30–60s.

### B4. Verify

```bash
docker compose ps                    # both services "running"
docker compose logs -f bot           # look for "chat connected" and "EventSub listening"
```

Then:
- Visit `https://bot.example.com/` → "BasecaBot is running." with a valid padlock.
- Visit `https://bot.example.com/wheel/` → the BasecaWheel harness loads; click Connect (the URL now auto-fills `wss://bot.example.com/ws?...` — just set the secret to your `WS_HUB_SECRET`).
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

## Part G — Optional upgrades

**GitLab CI/CD auto-deploy.** Add a pipeline that SSHes into the server and runs `./scripts/deploy.sh` on pushes to `main` (store an SSH key as a masked CI/CD variable). Nice once the manual flow feels routine.

**Postgres instead of SQLite.** For higher write volume or multiple bot processes:
1. Change `provider` in `prisma/schema.prisma` to `postgresql`.
2. Delete `prisma/migrations/` and regenerate against Postgres (`prisma migrate dev`), or use `prisma migrate diff`.
3. Add a `postgres` service to `docker-compose.yml` and set `DATABASE_URL` to it.

Not needed for a single always-on bot — SQLite on the volume is plenty.
