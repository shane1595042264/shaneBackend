#!/bin/sh
set -e

if [ -n "$DATABASE_URL" ]; then
  echo "[startup] Running database initialization..."
  bun run src/scripts/init-db.ts || echo "[startup] Database init failed, continuing with server startup..."
else
  echo "[startup] DATABASE_URL not set, skipping database initialization"
fi

echo "[startup] Starting server..."
exec bun run src/index.ts
