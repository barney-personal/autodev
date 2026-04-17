#!/bin/bash
set -euo pipefail

export PATH="/opt/homebrew/bin:$PATH"

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_DIR"

# Load runtime env for the LaunchAgent-managed production server.
# Dev already uses `--env-file=.env`; production should read the same source.
if [ -f .env ]; then
    set -a
    . ./.env
    set +a
fi

echo "[$(date)] Starting autodev with commit: $(git rev-parse --short HEAD)"

# Build if dist is missing or stale
if [ ! -d dist ] || [ "$(find src -newer dist/server/index.js -print -quit 2>/dev/null)" ]; then
    echo "[$(date)] Building..."
    npm run build 2>&1
fi

# Copy non-compiled assets
cp src/server/db/schema.sql dist/server/db/schema.sql

# Start server with Sentry preloaded so framework instrumentation attaches
# before Express and other server modules are imported.
exec node --import ./dist/server/instrument.js dist/server/index.js
