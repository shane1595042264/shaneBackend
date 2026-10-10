/**
 * SHAN-563. Adds `summary_changed` to trip_itinerary_suggestions.
 *
 *   bun scripts/add-suggestion-summary-changed.ts
 *
 * Phase 3.5 recovery path only: trip_itinerary_suggestions is an existing prod
 * table, so if the 0042 migration ever fails to apply this puts the column in
 * by hand. Normally drizzle-kit migrate has already done it and this is a
 * no-op. No backfill: prod had zero suggestion rows when the column shipped,
 * and false (keep the stored summary) is the safe reading for any old row.
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
       WHERE table_name = 'trip_itinerary_suggestions' AND column_name = 'summary_changed'`
  );
  console.log("summary_changed column before:", before.rows);

  if (before.rows.length === 0) {
    await client.query(
      `ALTER TABLE "trip_itinerary_suggestions" ADD COLUMN "summary_changed" boolean DEFAULT false NOT NULL`
    );
    console.log("ALTER TABLE executed");
  } else {
    console.log("summary_changed column already exists, no change");
  }
} finally {
  await client.end();
}
