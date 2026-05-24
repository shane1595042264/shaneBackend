/**
 * One-shot recovery: drop the NOT NULL constraint on trips.owner_id and
 * switch the FK to ON DELETE SET NULL. Migration 0008 silently no-op'd
 * (same drizzle row-count quirk that bit 0006 and 0007).
 *
 *   bun scripts/drop-trips-owner-notnull.ts
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
  // 1. Drop the NOT NULL constraint (idempotent: PG ignores if already nullable)
  const before = await client.query<{ is_nullable: string }>(
    `SELECT is_nullable FROM information_schema.columns
       WHERE table_name = 'trips' AND column_name = 'owner_id'`,
  );
  console.log("owner_id nullable before:", before.rows[0]?.is_nullable);
  if (before.rows[0]?.is_nullable === "NO") {
    await client.query(`ALTER TABLE "trips" ALTER COLUMN "owner_id" DROP NOT NULL`);
    console.log("+ DROP NOT NULL applied");
  } else {
    console.log("  already nullable, skipping");
  }

  // 2. Replace the FK so it uses ON DELETE SET NULL instead of RESTRICT.
  // Postgres has no IF EXISTS for constraint replacement; do it manually.
  const fk = await client.query(
    `SELECT confdeltype FROM pg_constraint WHERE conname = 'trips_owner_id_users_id_fk'`,
  );
  const currentDelType = fk.rows[0]?.confdeltype;
  // confdeltype: 'n' = SET NULL, 'r' = RESTRICT, 'a' = NO ACTION, etc.
  if (currentDelType !== "n") {
    await client.query(`ALTER TABLE "trips" DROP CONSTRAINT IF EXISTS "trips_owner_id_users_id_fk"`);
    await client.query(`
      ALTER TABLE "trips" ADD CONSTRAINT "trips_owner_id_users_id_fk"
        FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE SET NULL
    `);
    console.log("+ FK switched to ON DELETE SET NULL");
  } else {
    console.log("  FK already ON DELETE SET NULL, skipping");
  }

  const after = await client.query<{ is_nullable: string }>(
    `SELECT is_nullable FROM information_schema.columns
       WHERE table_name = 'trips' AND column_name = 'owner_id'`,
  );
  console.log("\nowner_id nullable after:", after.rows[0]?.is_nullable);
} finally {
  await client.end();
}
