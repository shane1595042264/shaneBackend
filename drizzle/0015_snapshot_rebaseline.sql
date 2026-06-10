-- SHAN-274: snapshot re-baseline marker. No schema changes.
-- Migrations 0011-0014 were hand-written without regenerating
-- drizzle/meta snapshots, which broke `bun run db:generate` (it diffed
-- against the stale 0010 snapshot and prompted interactively on phantom
-- drift). 0015_snapshot.json was produced from src/db/schema.ts via
-- drizzle-kit/api generateDrizzleJson; prod already matches (startup
-- sanity check verifies every table and column). This file exists only
-- so the journal, snapshots, and __drizzle_migrations stay 1:1.
SELECT 1;
