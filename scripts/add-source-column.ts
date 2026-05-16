/**
 * One-shot script to add the `source jsonb` column to vocab_words on prod.
 * Run when drizzle-kit push --force on startup silently no-ops (SHAN-159).
 *
 *   bun scripts/add-source-column.ts
 *
 * Idempotent: checks before altering.
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
       WHERE table_name = 'vocab_words' AND column_name = 'source'`
  );
  console.log("source column before:", before.rows);

  if (before.rows.length === 0) {
    await client.query(`ALTER TABLE "vocab_words" ADD COLUMN "source" jsonb`);
    console.log("ALTER TABLE executed");
  } else {
    console.log("source column already exists, no change");
  }

  const after = await client.query(
    `SELECT column_name, data_type FROM information_schema.columns
       WHERE table_name = 'vocab_words' AND column_name = 'source'`
  );
  console.log("source column after:", after.rows);
} finally {
  await client.end();
}
