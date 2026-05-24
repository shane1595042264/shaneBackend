/**
 * One-shot recovery script for migration 0006_abnormal_nebula.
 *
 * Adds users.timezone + author_timezone snapshots on the 4 journal tables.
 * Mirrors add-created-by-column.ts. Run when the startup migrator silently
 * no-ops (which it did after the 2026-05-23 push — the runtime never picked
 * up drizzle/0006_*.sql, probably a path resolution issue under the bundled
 * dist/ output).
 *
 *   bun scripts/add-timezone-columns.ts
 *
 * Idempotent — each ALTER is gated on information_schema lookup.
 */
import { Client } from "pg";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL must be set");
  process.exit(1);
}

const client = new Client({ connectionString: url });
await client.connect();

async function addColumnIfMissing(
  table: string,
  column: string,
  ddl: string,
): Promise<void> {
  const before = await client.query(
    `SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = $2`,
    [table, column],
  );
  if (before.rows.length > 0) {
    console.log(`✓ ${table}.${column} already exists, skipping`);
    return;
  }
  await client.query(`ALTER TABLE "${table}" ADD COLUMN ${ddl}`);
  console.log(`+ ${table}.${column} added`);
}

try {
  await addColumnIfMissing(
    "users",
    "timezone",
    `"timezone" varchar(64) DEFAULT 'America/Chicago' NOT NULL`,
  );
  await addColumnIfMissing(
    "journal_entries",
    "author_timezone",
    `"author_timezone" varchar(64)`,
  );
  await addColumnIfMissing(
    "journal_appends",
    "author_timezone",
    `"author_timezone" varchar(64)`,
  );
  await addColumnIfMissing(
    "journal_suggestions",
    "author_timezone",
    `"author_timezone" varchar(64)`,
  );
  await addColumnIfMissing(
    "journal_comments",
    "author_timezone",
    `"author_timezone" varchar(64)`,
  );

  const after = await client.query(
    `SELECT table_name, column_name FROM information_schema.columns
       WHERE (table_name = 'users' AND column_name = 'timezone')
          OR column_name = 'author_timezone'
       ORDER BY table_name, column_name`,
  );
  console.log("\nFinal state:");
  for (const row of after.rows) console.log(`  ${row.table_name}.${row.column_name}`);
} finally {
  await client.end();
}
