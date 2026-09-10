/**
 * One-shot script to add the Phase 4 calendar columns to training_plans on prod
 * (SHAN-473): session_time, reminder_minutes, ics_token + its unique index.
 * Only needed if the startup drizzle-kit migrate ever fails to apply 0036.
 *
 *   bun scripts/add-plan-calendar-columns.ts
 *
 * Idempotent: every statement is IF NOT EXISTS or guarded by a catalog check.
 */
import { Client } from "pg";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL must be set");
  process.exit(1);
}

const columns = `SELECT column_name, data_type FROM information_schema.columns
   WHERE table_name = 'training_plans'
     AND column_name IN ('session_time', 'reminder_minutes', 'ics_token')
   ORDER BY column_name`;

const client = new Client({ connectionString: url });
await client.connect();
try {
  console.log("before:", (await client.query(columns)).rows);

  await client.query(
    `ALTER TABLE "training_plans" ADD COLUMN IF NOT EXISTS "session_time" varchar(5)`,
  );
  await client.query(
    `ALTER TABLE "training_plans" ADD COLUMN IF NOT EXISTS "reminder_minutes" integer`,
  );
  await client.query(`ALTER TABLE "training_plans" ADD COLUMN IF NOT EXISTS "ics_token" uuid`);

  // ADD CONSTRAINT has no IF NOT EXISTS, so check pg_constraint first.
  const constraint = await client.query(
    `SELECT 1 FROM pg_constraint WHERE conname = 'training_plans_ics_token_unique'`,
  );
  if (constraint.rows.length === 0) {
    await client.query(
      `ALTER TABLE "training_plans" ADD CONSTRAINT "training_plans_ics_token_unique" UNIQUE ("ics_token")`,
    );
    console.log("unique constraint added");
  } else {
    console.log("unique constraint already present");
  }

  console.log("after:", (await client.query(columns)).rows);
} finally {
  await client.end();
}
