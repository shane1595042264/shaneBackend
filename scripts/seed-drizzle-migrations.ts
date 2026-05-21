/**
 * One-shot script to seed `drizzle.__drizzle_migrations` on prod so the
 * switch from `drizzle-kit push --force` to `drizzle-kit migrate` is a
 * no-op for the existing 0000-0005 migrations.
 *
 *   bun scripts/seed-drizzle-migrations.ts
 *
 * Why: prod was built by `push --force` over months. The migration files
 * exist on disk and the equivalent schema is live, but __drizzle_migrations
 * itself has never existed. If we just flipped to migrate, drizzle would
 * try to apply all 6 migrations and 0000 would fail because diary_entries
 * is now legacy_diary_entries. Pre-seeding the table tells drizzle "these
 * are already done, only run anything strictly newer."
 *
 * Idempotent: skips inserts that already exist (matching by hash).
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

// drizzle's migrator reads each .sql file as a UTF-8 string and hashes the
// raw content with sha256 — same routine that runs at migrate time. We
// mirror that exactly so the hashes we insert match what drizzle would
// have computed itself.
const seeds = journal.entries
  .sort((a, b) => a.idx - b.idx)
  .map((entry) => {
    const file = readFileSync(join("drizzle", `${entry.tag}.sql`));
    return {
      tag: entry.tag,
      when: entry.when,
      hash: createHash("sha256").update(file).digest("hex"),
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

  const existing = await client.query<{ hash: string }>(
    `SELECT hash FROM "drizzle"."__drizzle_migrations"`
  );
  const have = new Set(existing.rows.map((r) => r.hash));

  let inserted = 0;
  let skipped = 0;
  for (const seed of seeds) {
    if (have.has(seed.hash)) {
      console.log(`  [skip] ${seed.tag} (already in __drizzle_migrations)`);
      skipped += 1;
      continue;
    }
    await client.query(
      `INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ($1, $2)`,
      [seed.hash, seed.when]
    );
    console.log(`  [insert] ${seed.tag} hash=${seed.hash.slice(0, 12)} when=${seed.when}`);
    inserted += 1;
  }

  const after = await client.query(
    `SELECT id, hash, created_at FROM "drizzle"."__drizzle_migrations" ORDER BY created_at`
  );
  console.log(
    `\nDone. inserted=${inserted} skipped=${skipped} total_now=${after.rowCount}`
  );
} finally {
  await client.end();
}
