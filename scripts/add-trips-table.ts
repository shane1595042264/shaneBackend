/**
 * One-shot recovery: create the trips table on prod when the startup
 * migrator silently no-op'd 0007 (same family of bug as add-timezone-columns.ts).
 *
 *   bun scripts/add-trips-table.ts
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
    `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'trips'`,
  );
  if (before.rowCount && before.rowCount > 0) {
    console.log("✓ trips table already exists, nothing to do");
  } else {
    await client.query(`
      CREATE TABLE "trips" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
        "slug" varchar(80) NOT NULL,
        "owner_id" uuid NOT NULL,
        "title" text,
        "html" text NOT NULL,
        "source_filename" varchar(255),
        "created_at" timestamp with time zone DEFAULT now() NOT NULL,
        "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
        CONSTRAINT "trips_slug_unique" UNIQUE("slug")
      )
    `);
    console.log("+ trips table created");
    await client.query(`
      ALTER TABLE "trips" ADD CONSTRAINT "trips_owner_id_users_id_fk"
        FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict
    `);
    console.log("+ FK trips_owner_id_users_id_fk added");
    await client.query(
      `CREATE INDEX "trips_owner_created_idx" ON "trips" USING btree ("owner_id","created_at")`,
    );
    console.log("+ trips_owner_created_idx created");
  }

  const after = await client.query(
    `SELECT column_name, data_type FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'trips'
       ORDER BY ordinal_position`,
  );
  console.log("\nFinal columns:");
  for (const r of after.rows) console.log(`  ${r.column_name}: ${r.data_type}`);
} finally {
  await client.end();
}
