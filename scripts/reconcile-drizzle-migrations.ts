/**
 * One-shot recovery: clean up __drizzle_migrations so its contents match
 * exactly what drizzle-kit would compute from the current SQL files.
 *
 * Background: prior seeding runs inserted duplicate rows for 0001 and
 * 0002 (different hashes from the same migration tag — the SQL content
 * was edited between seedings). drizzle's migrate() compares the row
 * count to the file count and silently no-ops when applied >= files,
 * which is exactly what blocked 0007 (trips) from running this morning.
 *
 * After this script:
 *   - migrations rows == migration files, one row per file
 *   - hashes match what drizzle would compute today
 *   - drizzle's next migrate() will see 0007 as unapplied and run it
 *
 *   bun scripts/reconcile-drizzle-migrations.ts
 *
 * Idempotent. Run once, verify, redeploy.
 */
import { Client } from "pg";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL must be set");
  process.exit(1);
}

const journalPath = join("drizzle", "meta", "_journal.json");
const journal = JSON.parse(readFileSync(journalPath, "utf-8")) as {
  entries: { idx: number; when: number; tag: string }[];
};

// Same hash routine drizzle's migrator uses internally.
const targetRows = journal.entries
  .sort((a, b) => a.idx - b.idx)
  .map((entry) => {
    const buf = readFileSync(join("drizzle", `${entry.tag}.sql`));
    return {
      tag: entry.tag,
      when: entry.when,
      hash: createHash("sha256").update(buf).digest("hex"),
    };
  });

const client = new Client({ connectionString: url });
await client.connect();
try {
  await client.query(`CREATE SCHEMA IF NOT EXISTS "drizzle"`);
  await client.query(`
    CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations" (
      id SERIAL PRIMARY KEY,
      hash text NOT NULL,
      created_at bigint
    )
  `);

  const before = await client.query<{ id: number; hash: string; created_at: number }>(
    `SELECT id, hash, created_at FROM "drizzle"."__drizzle_migrations" ORDER BY id`,
  );
  console.log(`Before: ${before.rowCount} rows`);
  for (const r of before.rows) {
    console.log(`  id=${r.id} hash=${r.hash.slice(0, 12)} when=${r.created_at}`);
  }

  console.log(`\nFiles on disk: ${targetRows.length}`);
  for (const t of targetRows) {
    console.log(`  ${t.tag} hash=${t.hash.slice(0, 12)} when=${t.when}`);
  }

  // Wipe + re-seed. Safe because the schema itself is unaffected; only the
  // tracking table is being rewritten to match reality.
  await client.query(`TRUNCATE "drizzle"."__drizzle_migrations" RESTART IDENTITY`);
  for (const t of targetRows) {
    await client.query(
      `INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ($1, $2)`,
      [t.hash, t.when],
    );
  }

  const after = await client.query<{ id: number; hash: string; created_at: number }>(
    `SELECT id, hash, created_at FROM "drizzle"."__drizzle_migrations" ORDER BY id`,
  );
  console.log(`\nAfter: ${after.rowCount} rows (should equal file count ${targetRows.length})`);

  // Note: trips table itself still needs to exist. If 0007 hasn't been
  // applied AND we just marked it applied, the drizzle migrator won't
  // create it on the next boot. Caller should run add-trips-table.ts
  // separately if the table is still missing.
} finally {
  await client.end();
}
