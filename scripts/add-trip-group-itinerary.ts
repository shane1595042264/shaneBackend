/**
 * One-shot script to add the `itinerary jsonb` and `itinerary_generated_at
 * timestamptz` columns to trip_groups on prod (SHAN-272). Recovery path in
 * case drizzle-kit migrate on startup fails to apply 0014_trip_group_itinerary.
 *
 *   bun scripts/add-trip-group-itinerary.ts
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
       WHERE table_name = 'trip_groups' AND column_name IN ('itinerary', 'itinerary_generated_at')`
  );
  console.log("itinerary columns before:", before.rows);

  if (!before.rows.some((r) => r.column_name === "itinerary")) {
    await client.query(`ALTER TABLE "trip_groups" ADD COLUMN "itinerary" jsonb`);
    console.log("ALTER TABLE add itinerary executed");
  }
  if (!before.rows.some((r) => r.column_name === "itinerary_generated_at")) {
    await client.query(
      `ALTER TABLE "trip_groups" ADD COLUMN "itinerary_generated_at" timestamp with time zone`
    );
    console.log("ALTER TABLE add itinerary_generated_at executed");
  }

  const after = await client.query(
    `SELECT column_name, data_type FROM information_schema.columns
       WHERE table_name = 'trip_groups' AND column_name IN ('itinerary', 'itinerary_generated_at')`
  );
  console.log("itinerary columns after:", after.rows);
} finally {
  await client.end();
}
