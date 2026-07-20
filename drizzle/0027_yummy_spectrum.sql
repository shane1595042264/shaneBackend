-- SHAN-406: IF EXISTS / IF NOT EXISTS added by hand. Prod drifted from 0000 —
-- rng_decisions_created_at_idx was never physically created (seeded as applied
-- during the push->migrate cutover), so a bare DROP INDEX would crash startup.
DROP INDEX IF EXISTS "rng_decisions_created_at_idx";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rng_decisions_user_created_idx" ON "rng_decisions" USING btree ("user_id","created_at");
