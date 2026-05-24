#!/bin/sh
# Diagnostic logs are deliberate — silent boot is exactly how the migration
# no-op (SHAN-159) hid for hours. Cheap to keep, expensive to lose.
echo "[startup] start.sh entered: pwd=$(pwd) user=$(whoami)"
echo "[startup] drizzle/ contents:"
ls -1 drizzle 2>&1 | head -20 || echo "[startup]   (no drizzle/ directory!)"
exec bun run src/index.ts
