/**
 * One-shot script to add the `created_by uuid` column (FK to users) on
 * vocab_words. Mirrors add-source-column.ts. Run when drizzle-kit push --force
 * on startup silently no-ops (SHAN-159).
 *
 *   bun scripts/add-created-by-column.ts
 *
 * Idempotent.
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
    `SELECT column_name, data_type FROM information_schema.columns
       WHERE table_name = 'vocab_words' AND column_name = 'created_by'`
  );
  console.log("created_by column before:", before.rows);

  if (before.rows.length === 0) {
    await client.query(`ALTER TABLE "vocab_words" ADD COLUMN "created_by" uuid`);
    console.log("ALTER TABLE ADD COLUMN executed");
  }

  const fk = await client.query(
    `SELECT 1 FROM information_schema.table_constraints
       WHERE constraint_name = 'vocab_words_created_by_users_id_fk'`
  );
  if (fk.rows.length === 0) {
    await client.query(
      `ALTER TABLE "vocab_words"
         ADD CONSTRAINT "vocab_words_created_by_users_id_fk"
         FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL`
    );
    console.log("FK constraint added");
  }

  const idx = await client.query(
    `SELECT 1 FROM pg_indexes
       WHERE indexname = 'vocab_words_created_by_idx'`
  );
  if (idx.rows.length === 0) {
    await client.query(
      `CREATE INDEX "vocab_words_created_by_idx" ON "vocab_words" ("created_by")`
    );
    console.log("Index created");
  }

  const after = await client.query(
    `SELECT column_name, data_type FROM information_schema.columns
       WHERE table_name = 'vocab_words' AND column_name = 'created_by'`
  );
  console.log("created_by column after:", after.rows);
} finally {
  await client.end();
}
