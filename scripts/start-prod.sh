#!/bin/bash
set -euo pipefail
export PATH="/opt/homebrew/bin:$PATH"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"
# Build explicitly before deploying. Startup never mutates an installed release.
if [ ! -f dist/server/db/schema.sql ] || [ ! -f dist/client/index.html ]; then
    echo 'Missing production assets. Run npm ci && npm run build before starting.' >&2
    exit 1
fi
exec node --env-file-if-exists=.env --import ./dist/server/instrument.js dist/server/index.js
