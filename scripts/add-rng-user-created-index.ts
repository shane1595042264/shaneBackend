/**
 * One-shot script to swap the rng_decisions index on prod:
 *   drop rng_decisions_created_at_idx (created_at alone — backed no query),
 *   add rng_decisions_user_created_idx (user_id, created_at).
 * The composite serves the only read query, keyset-paginated GET
 * /api/rng/history: WHERE user_id = ? [AND created_at < cursor] ORDER BY
 * created_at DESC. Mirrors loan_entries_user_created_idx (SHAN-394) / SHAN-406.
 *
 * Run only if drizzle-kit migrate on startup fails to apply 0027 for some
 * reason (rare — the migrate sanity check only verifies tables, not indexes):
 *
 *   bun scripts/add-rng-user-created-index.ts
 *
 * Idempotent: CREATE INDEX IF NOT EXISTS + DROP INDEX IF EXISTS.
 */
import { Client } from "pg";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL must be set");
  process.exit(1);
}

const client = new Client({ connectionString: url });
await client.connect();
try {
  const before = await client.query(
    `SELECT indexname FROM pg_indexes
       WHERE indexname IN ('rng_decisions_created_at_idx', 'rng_decisions_user_created_idx')`
  );
  console.log("rng_decisions indexes before:", before.rows);

  await client.query(
    `CREATE INDEX IF NOT EXISTS "rng_decisions_user_created_idx" ON "rng_decisions" USING btree ("user_id","created_at")`
  );
  await client.query(`DROP INDEX IF EXISTS "rng_decisions_created_at_idx"`);
  console.log("index swap executed");

  const after = await client.query(
    `SELECT indexname FROM pg_indexes
       WHERE indexname IN ('rng_decisions_created_at_idx', 'rng_decisions_user_created_idx')`
  );
  console.log("rng_decisions indexes after:", after.rows);
} finally {
  await client.end();
}
