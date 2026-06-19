/**
 * One-shot script to add the `universal_tea_pin varchar(4)` column to users
 * on prod if drizzle-kit migrate on startup fails for some reason (SHAN-320).
 *
 *   bun scripts/add-universal-tea-pin.ts
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
    `SELECT column_name, data_type, character_maximum_length FROM information_schema.columns
       WHERE table_name = 'users' AND column_name = 'universal_tea_pin'`
  );
  console.log("universal_tea_pin column before:", before.rows);

  if (before.rows.length === 0) {
    await client.query(`ALTER TABLE "users" ADD COLUMN "universal_tea_pin" varchar(4)`);
    console.log("ALTER TABLE executed");
  } else {
    console.log("universal_tea_pin column already exists, no change");
  }

  const after = await client.query(
    `SELECT column_name, data_type, character_maximum_length FROM information_schema.columns
       WHERE table_name = 'users' AND column_name = 'universal_tea_pin'`
  );
  console.log("universal_tea_pin column after:", after.rows);
} finally {
  await client.end();
}
