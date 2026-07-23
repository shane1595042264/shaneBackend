/**
 * One-shot script to add the composite rng_ban_list index on prod:
 *   add rng_ban_list_user_expires_idx (user_id, expires_at).
 * The composite serves the hot-path ban lookup run on every purchase
 * evaluation, POST /api/rng/evaluate and GET /api/rng/bans:
 * WHERE user_id = ? AND expires_at > now(). The pre-existing
 * rng_ban_list_expires_at_idx (expires_at alone) forced a global
 * active-ban scan then a user_id heap filter. Mirrors SHAN-406 /
 * SHAN-394 index shape.
 *
 * Run only if drizzle-kit migrate on startup fails to apply 0029 for some
 * reason (rare — the migrate sanity check only verifies tables, not indexes):
 *
 *   bun scripts/add-rng-ban-user-expires-index.ts
 *
 * Idempotent: CREATE INDEX IF NOT EXISTS.
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
       WHERE indexname IN ('rng_ban_list_expires_at_idx', 'rng_ban_list_user_expires_idx')`
  );
  console.log("rng_ban_list indexes before:", before.rows);

  await client.query(
    `CREATE INDEX IF NOT EXISTS "rng_ban_list_user_expires_idx" ON "rng_ban_list" USING btree ("user_id","expires_at")`
  );
  console.log("index create executed");

  const after = await client.query(
    `SELECT indexname FROM pg_indexes
       WHERE indexname IN ('rng_ban_list_expires_at_idx', 'rng_ban_list_user_expires_idx')`
  );
  console.log("rng_ban_list indexes after:", after.rows);
} finally {
  await client.end();
}
