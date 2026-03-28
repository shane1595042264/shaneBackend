#!/bin/sh
set -e

echo "[startup] Pushing database schema..."
bunx drizzle-kit push --force 2>&1 || echo "[startup] Schema push skipped (DB may not be ready yet)"

echo "[startup] Starting server..."
exec bun run src/index.ts
