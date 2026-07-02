/**
 * One-shot recovery script to add the location-memorization columns (SHAN-339)
 * to vocab_words on prod, in case drizzle-kit migrate on startup ever fails to
 * apply migration 0022.
 *
 *   bun scripts/add-memorization-locations.ts
 *
 * Idempotent: checks before altering each column.
 */
import { Client } from "pg";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL must be set");
  process.exit(1);
}

const columns = [
  { name: "memorization_locations", ddl: `ALTER TABLE "vocab_words" ADD COLUMN "memorization_locations" jsonb DEFAULT '[]'::jsonb` },
  { name: "long_term_memorized", ddl: `ALTER TABLE "vocab_words" ADD COLUMN "long_term_memorized" boolean DEFAULT false NOT NULL` },
];

const client = new Client({ connectionString: url });
await client.connect();
try {
  for (const col of columns) {
    const before = await client.query(
      `SELECT column_name FROM information_schema.columns
         WHERE table_name = 'vocab_words' AND column_name = $1`,
      [col.name]
    );
    if (before.rows.length === 0) {
      await client.query(col.ddl);
      console.log(`added column ${col.name}`);
    } else {
      console.log(`column ${col.name} already exists, no change`);
    }
  }

  const after = await client.query(
    `SELECT column_name, data_type FROM information_schema.columns
       WHERE table_name = 'vocab_words'
         AND column_name IN ('memorization_locations', 'long_term_memorized')`
  );
  console.log("columns after:", after.rows);
} finally {
  await client.end();
}
