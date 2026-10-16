/**
 * SHAN-584. Scopes rng_monthly_spend to a user: cascading user_id FK and a
 * unique (user_id, year_month) in place of the month-only unique.
 *
 *   bun scripts/add-rng-monthly-spend-user.ts
 *
 * Phase 3.5 recovery path only: if the 0045 migration ever fails to apply this
 * does the same thing by hand. Normally drizzle-kit migrate has already done it
 * and this is a no-op. No backfill: the two pre-existing rows belonged to a
 * Plaid token with no user, and reads filter on user_id, so they stay unread.
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
  const constraints = async () =>
    (
      await client.query(
        `SELECT conname FROM pg_constraint WHERE conrelid = 'rng_monthly_spend'::regclass`
      )
    ).rows.map((r) => r.conname as string);

  const before = await constraints();
  console.log("constraints before:", before);

  await client.query("BEGIN");
  await client.query(`ALTER TABLE "rng_monthly_spend" DROP CONSTRAINT IF EXISTS "rng_monthly_spend_year_month_unique"`);
  await client.query(`ALTER TABLE "rng_monthly_spend" DROP CONSTRAINT IF EXISTS "rng_monthly_spend_year_month_key"`);
  await client.query(`ALTER TABLE "rng_monthly_spend" ADD COLUMN IF NOT EXISTS "user_id" uuid`);
  await client.query(`ALTER TABLE "rng_monthly_spend" DROP CONSTRAINT IF EXISTS "rng_monthly_spend_user_id_fkey"`);
  if (!before.includes("rng_monthly_spend_user_id_users_id_fk")) {
    await client.query(
      `ALTER TABLE "rng_monthly_spend" ADD CONSTRAINT "rng_monthly_spend_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action`
    );
  }
  if (!before.includes("rng_monthly_spend_user_year_month_unique")) {
    await client.query(
      `ALTER TABLE "rng_monthly_spend" ADD CONSTRAINT "rng_monthly_spend_user_year_month_unique" UNIQUE("user_id","year_month")`
    );
  }
  await client.query("COMMIT");

  console.log("constraints after:", await constraints());
} catch (err) {
  await client.query("ROLLBACK");
  throw err;
} finally {
  await client.end();
}
