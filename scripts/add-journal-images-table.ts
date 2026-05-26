/**
 * One-shot recovery: create the journal_images table on prod if the startup
 * migrator ever fails to apply 0009_nasty_phalanx.sql (e.g. during a Railway
 * platform incident). Mirrors scripts/add-trips-table.ts.
 *
 *   bun scripts/add-journal-images-table.ts
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
       WHERE table_schema = 'public' AND table_name = 'journal_images'`,
  );
  if (before.rowCount && before.rowCount > 0) {
    console.log("✓ journal_images table already exists, nothing to do");
  } else {
    await client.query(`
      CREATE TABLE "journal_images" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
        "uploaded_by" uuid NOT NULL,
        "mime_type" varchar(100) NOT NULL,
        "byte_size" integer NOT NULL,
        "data" "bytea" NOT NULL,
        "created_at" timestamp with time zone DEFAULT now() NOT NULL
      )
    `);
    console.log("+ journal_images table created");
    await client.query(`
      ALTER TABLE "journal_images" ADD CONSTRAINT "journal_images_uploaded_by_users_id_fk"
        FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE restrict
    `);
    console.log("+ FK journal_images_uploaded_by_users_id_fk added");
    await client.query(
      `CREATE INDEX "journal_images_uploaded_by_idx" ON "journal_images" USING btree ("uploaded_by")`,
    );
    console.log("+ journal_images_uploaded_by_idx created");
  }

  const after = await client.query(
    `SELECT column_name, data_type FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'journal_images'
       ORDER BY ordinal_position`,
  );
  console.log("\nFinal columns:");
  for (const r of after.rows) console.log(`  ${r.column_name}: ${r.data_type}`);
} finally {
  await client.end();
}
