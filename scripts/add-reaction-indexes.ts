/**
 * One-shot script to add the reaction-summary indexes on prod:
 *   entry_reactions(entry_id) and comment_reactions(comment_id).
 * These back summarizeEntryReactions/summarizeCommentReactions, which filter
 * by entry_id/comment_id alone — the composite unique constraints lead with
 * user_id and can't serve those queries (SHAN-341).
 *
 * Run only if drizzle-kit migrate on startup fails to apply 0023 for some
 * reason (rare — the migrate sanity check only verifies tables, not indexes):
 *
 *   bun scripts/add-reaction-indexes.ts
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
       WHERE indexname IN ('entry_reactions_entry_id_idx', 'comment_reactions_comment_id_idx')`
  );
  console.log("reaction indexes before:", before.rows);

  await client.query(
    `CREATE INDEX IF NOT EXISTS "entry_reactions_entry_id_idx" ON "entry_reactions" USING btree ("entry_id")`
  );
  await client.query(
    `CREATE INDEX IF NOT EXISTS "comment_reactions_comment_id_idx" ON "comment_reactions" USING btree ("comment_id")`
  );
  console.log("CREATE INDEX IF NOT EXISTS executed");

  const after = await client.query(
    `SELECT indexname FROM pg_indexes
       WHERE indexname IN ('entry_reactions_entry_id_idx', 'comment_reactions_comment_id_idx')`
  );
  console.log("reaction indexes after:", after.rows);
} finally {
  await client.end();
}
