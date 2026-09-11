/**
 * One-shot recovery script for SHAN-483: creates the journal_activity table +
 * its enum, and adds edited_at / deleted_at to the existing journal_appends
 * table on prod.
 *
 *   bun scripts/add-journal-activity.ts
 *
 * Normally you never need this — drizzle/0038_moaning_goliath.sql runs on
 * startup via runStartupMigrations(). Keep it for the case where migrate
 * fails mid-deploy (Railway incident, partial apply) and you need the
 * psql-equivalent by hand. Idempotent: every statement is guarded.
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
  // 1. enum — CREATE TYPE has no IF NOT EXISTS, so check the catalog first.
  const enumExists = await client.query(
    `SELECT 1 FROM pg_type WHERE typname = 'journal_activity_action'`
  );
  if (enumExists.rows.length === 0) {
    await client.query(`
      CREATE TYPE "public"."journal_activity_action" AS ENUM(
        'entry.create','entry.delete','entry.revert',
        'append.create','append.update','append.delete',
        'comment.create','comment.update','comment.delete',
        'suggestion.create','suggestion.approve','suggestion.reject','suggestion.withdraw'
      )`);
    console.log("created enum journal_activity_action");
  } else {
    console.log("enum journal_activity_action already exists");
  }

  // 2. table
  await client.query(`
    CREATE TABLE IF NOT EXISTS "journal_activity" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
      "entry_id" uuid REFERENCES "public"."journal_entries"("id") ON DELETE set null,
      "entry_date" date NOT NULL,
      "action" "journal_activity_action" NOT NULL,
      "target_type" varchar(32) NOT NULL,
      "target_id" uuid,
      "actor_id" uuid NOT NULL REFERENCES "public"."users"("id") ON DELETE restrict,
      "actor_token_id" uuid REFERENCES "public"."api_tokens"("id") ON DELETE set null,
      "detail" jsonb,
      "created_at" timestamp with time zone DEFAULT now() NOT NULL
    )`);
  await client.query(
    `CREATE INDEX IF NOT EXISTS "journal_activity_created_idx" ON "journal_activity" USING btree ("created_at")`
  );
  await client.query(
    `CREATE INDEX IF NOT EXISTS "journal_activity_entry_created_idx" ON "journal_activity" USING btree ("entry_id","created_at")`
  );

  // 3. new columns on the existing journal_appends table
  await client.query(
    `ALTER TABLE "journal_appends" ADD COLUMN IF NOT EXISTS "edited_at" timestamp with time zone`
  );
  await client.query(
    `ALTER TABLE "journal_appends" ADD COLUMN IF NOT EXISTS "deleted_at" timestamp with time zone`
  );

  const after = await client.query(
    `SELECT table_name, column_name FROM information_schema.columns
       WHERE (table_name = 'journal_activity')
          OR (table_name = 'journal_appends' AND column_name IN ('edited_at','deleted_at'))
       ORDER BY table_name, column_name`
  );
  console.log("after:", after.rows);
} finally {
  await client.end();
}
