/**
 * SHAN-541. Adds `word_count` to blog_posts and backfills it from each post's
 * current version.
 *
 *   bun scripts/add-blog-word-count.ts
 *
 * Two jobs in one script, on purpose:
 *
 *  1. The ALTER is the Phase 3.5 recovery path — blog_posts is an existing prod
 *     table, so if the 0041 migration ever fails to apply this puts the column
 *     in by hand. Normally drizzle-kit migrate has already done it and this
 *     part is a no-op.
 *  2. The backfill is NOT optional and has no migration equivalent. The count
 *     has to come from the same markdown-aware counter the write paths use, and
 *     Postgres cannot reproduce it (a whitespace split counts heading hashes
 *     and list markers, and keeps whole code fences the counter drops — it came
 *     out 4.7% high on the one real post, enough to flip the ceil()). So the
 *     column lands as 0 and this walks the rows in TypeScript.
 *
 * Idempotent: only rows still at 0 are touched, so re-running it after new
 * posts exist costs one query and changes nothing. A post whose body really is
 * markup-only counts 0 and gets rewritten to 0, which is the correct value and
 * renders as no reading time.
 */
import { Client } from "pg";
import { countBodyWords } from "../src/modules/shared/word-count";

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
       WHERE table_name = 'blog_posts' AND column_name = 'word_count'`
  );
  console.log("word_count column before:", before.rows);

  if (before.rows.length === 0) {
    await client.query(
      `ALTER TABLE "blog_posts" ADD COLUMN "word_count" integer DEFAULT 0 NOT NULL`
    );
    console.log("ALTER TABLE executed");
  } else {
    console.log("word_count column already exists, no change");
  }

  // Current version only. Older versions are history; nothing renders their
  // length. A post with no current version (should not happen) is skipped
  // rather than zeroed, so the anomaly stays visible.
  const { rows } = await client.query<{ id: string; slug: string; content: string }>(
    `SELECT p.id, p.slug, v.content
       FROM blog_posts p
       JOIN blog_versions v ON v.id = p.current_version_id
      WHERE p.word_count = 0`
  );
  console.log(`rows to backfill: ${rows.length}`);

  for (const row of rows) {
    const words = countBodyWords(row.content);
    await client.query(`UPDATE blog_posts SET word_count = $1 WHERE id = $2`, [
      words,
      row.id,
    ]);
    console.log(`  ${row.slug}: ${words} words (~${Math.max(1, Math.ceil(words / 225))} min)`);
  }

  const after = await client.query(
    `SELECT slug, word_count FROM blog_posts WHERE status <> 'trashed' ORDER BY published_at DESC`
  );
  console.log("word_count after:", after.rows);
} finally {
  await client.end();
}
