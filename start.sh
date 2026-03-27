#!/bin/sh
set -e

echo "[startup] Running database initialization..."
bun run src/scripts/init-db.ts

echo "[startup] Starting server..."
exec bun run src/index.ts
