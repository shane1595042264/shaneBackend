#!/bin/sh
set -e

echo "[startup] Starting server..."
exec bun run src/index.ts
