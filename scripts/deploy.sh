#!/usr/bin/env bash
#
# Run ON THE SERVER, from anywhere inside the repo, to ship the latest commit:
#   ./scripts/deploy.sh
#
# Pulls the latest code, rebuilds the image, and restarts the stack. Prisma
# migrations run automatically on container start (prisma migrate deploy).
set -euo pipefail

cd "$(dirname "$0")/.."

echo "==> Pulling latest code"
git pull --ff-only

echo "==> Rebuilding and restarting containers"
# --remove-orphans cleans up containers no longer in the compose file
# (e.g. the old bundled `caddy` service now handled by the edge-server project).
docker compose up -d --build --remove-orphans

echo "==> Current status"
docker compose ps

echo "==> Recent bot logs (Ctrl-C to stop tailing)"
docker compose logs -f --tail=50 bot
