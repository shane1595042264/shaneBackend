/**
 * One-shot script to create the `knowledge_comments` table on prod.
 *
 *   bun scripts/add-knowledge-comments-table.ts
 *
 * Recovery for the SHAN-188 ship: schema.ts defined the table but
 * `drizzle-kit push --force` on Railway startup silently no-op'd it
 * (same SHAN-159 pattern that bit `vocab_words.source` previously).
 * Idempotent — checks existence before each DDL.
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
  const exists = await client.query("SELECT to_regclass('knowledge_comments') AS r");
  if (exists.rows[0].r) {
    console.log("knowledge_comments already exists, no change");
  } else {
    await client.query(`
      CREATE TABLE "knowledge_comments" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "entry_id" uuid NOT NULL REFERENCES "vocab_words"("id") ON DELETE CASCADE,
        "parent_comment_id" uuid,
        "author_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
        "content" text NOT NULL,
        "edited_at" timestamptz,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now()
      )
    `);
    console.log("CREATE TABLE knowledge_comments executed");
  }

  const idxExists = await client.query(
    "SELECT 1 FROM pg_indexes WHERE indexname = 'knowledge_comments_entry_idx'"
  );
  if (idxExists.rowCount === 0) {
    await client.query(
      `CREATE INDEX "knowledge_comments_entry_idx" ON "knowledge_comments" ("entry_id")`
    );
    console.log("CREATE INDEX knowledge_comments_entry_idx executed");
  } else {
    console.log("index knowledge_comments_entry_idx already exists, no change");
  }

  const after = await client.query(
    "SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'knowledge_comments' ORDER BY ordinal_position"
  );
  console.log("knowledge_comments columns:", after.rows);
} finally {
  await client.end();
}
