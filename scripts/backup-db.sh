#!/usr/bin/env bash
#
# Run ON THE SERVER to copy the SQLite database out of the running bot container.
#   ./scripts/backup-db.sh
#
# Writes a timestamped copy under ./backups/. Run it when the bot is idle for a
# clean snapshot (a plain copy of a busy SQLite file can be inconsistent).
set -euo pipefail

cd "$(dirname "$0")/.."
mkdir -p backups
stamp="$(date +%Y%m%d-%H%M%S)"
out="backups/basecabot-${stamp}.db"

docker compose cp bot:/data/basecabot.db "$out"
echo "==> Backup written to ${out}"
