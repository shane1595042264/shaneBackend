/**
 * One-shot script to swap the vocab_words browse indexes on prod (SHAN-410):
 *   drop vocab_words_language_idx / vocab_words_category_idx (single-column),
 *   add  vocab_words_language_created_idx (language, created_at)
 *        vocab_words_category_created_idx (category, created_at).
 * The composites serve the knowledge browse query, GET /api/knowledge/entries:
 *   WHERE language|category = ? ORDER BY created_at DESC LIMIT ? OFFSET ?
 * so Postgres filters and returns rows in sort order via one index scan instead
 * of a filter + separate Sort. Mirrors rng_decisions (SHAN-406) / loan_entries
 * (SHAN-394). The standalone created_at index is kept for the no-filter browse.
 *
 * Run only if drizzle-kit migrate on startup fails to apply 0028 for some
 * reason (rare — the migrate sanity check only verifies tables, not indexes):
 *
 *   bun scripts/add-vocab-browse-indexes.ts
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
  const names = `('vocab_words_language_idx', 'vocab_words_category_idx',
     'vocab_words_language_created_idx', 'vocab_words_category_created_idx')`;
  const before = await client.query(
    `SELECT indexname FROM pg_indexes WHERE indexname IN ${names}`
  );
  console.log("vocab_words browse indexes before:", before.rows);

  await client.query(
    `CREATE INDEX IF NOT EXISTS "vocab_words_language_created_idx" ON "vocab_words" USING btree ("language","created_at")`
  );
  await client.query(
    `CREATE INDEX IF NOT EXISTS "vocab_words_category_created_idx" ON "vocab_words" USING btree ("category","created_at")`
  );
  await client.query(`DROP INDEX IF EXISTS "vocab_words_language_idx"`);
  await client.query(`DROP INDEX IF EXISTS "vocab_words_category_idx"`);
  console.log("index swap executed");

  const after = await client.query(
    `SELECT indexname FROM pg_indexes WHERE indexname IN ${names}`
  );
  console.log("vocab_words browse indexes after:", after.rows);
} finally {
  await client.end();
}
