/**
 * One-shot script to add the `direction varchar(20)` column to loan_entries on
 * prod. Backstop in case drizzle-kit migrate on startup ever fails to apply
 * 0024_young_zaladane.sql (SHAN-354).
 *
 *   bun scripts/add-loan-direction-column.ts
 *
 * Idempotent: checks before altering. Defaults to 'owed_to_me' (legacy: every
 * existing loan is money someone owes Shane).
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
       WHERE table_name = 'loan_entries' AND column_name = 'direction'`
  );
  console.log("direction column before:", before.rows);

  if (before.rows.length === 0) {
    await client.query(
      `ALTER TABLE "loan_entries" ADD COLUMN "direction" varchar(20) DEFAULT 'owed_to_me' NOT NULL`
    );
    console.log("ALTER TABLE executed");
  } else {
    console.log("direction column already exists, no change");
  }

  const after = await client.query(
    `SELECT column_name, data_type FROM information_schema.columns
       WHERE table_name = 'loan_entries' AND column_name = 'direction'`
  );
  console.log("direction column after:", after.rows);
} finally {
  await client.end();
}
