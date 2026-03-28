#!/bin/sh
set -e

# Railway env vars may not be injected immediately — wait a moment
sleep 3

if [ -n "$DATABASE_URL" ]; then
  echo "[startup] Pushing database schema..."
  bunx drizzle-kit push --force 2>&1 || echo "[startup] Schema push failed, continuing..."
else
  echo "[startup] DATABASE_URL not ready, skipping schema push"
fi

echo "[startup] Starting server..."
exec bun run src/index.ts
