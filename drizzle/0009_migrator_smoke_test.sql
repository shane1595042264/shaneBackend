-- Throwaway migration to prove the new hash-based migrator actually applies
-- pending SQL on deploy. Idempotent (IF NOT EXISTS) so re-running is fine.
-- Reverted in the very next commit.
CREATE INDEX IF NOT EXISTS "trips_updated_at_smoke_idx" ON "trips" ("updated_at");
