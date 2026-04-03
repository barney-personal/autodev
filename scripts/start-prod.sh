#!/bin/bash
set -euo pipefail

export PATH="/opt/homebrew/bin:$PATH"

REPO_DIR="/Users/barneyhussey-yeo/GitHub/personal/hurlicane"
cd "$REPO_DIR"

echo "[$(date)] Starting hurlicane with commit: $(git rev-parse --short HEAD)"

# Build if dist is missing or stale
if [ ! -d dist ] || [ "$(find src -newer dist/server/index.js -print -quit 2>/dev/null)" ]; then
    echo "[$(date)] Building..."
    npm run build 2>&1
fi

# Copy non-compiled assets
cp src/server/db/schema.sql dist/server/db/schema.sql

# Start server
exec node dist/server/index.js
