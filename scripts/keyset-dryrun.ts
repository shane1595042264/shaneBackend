/**
 * Read-only dry run for the SHAN-513 compound keyset predicate.
 *
 * The unit tests mock drizzle, so they cannot prove the generated SQL is
 * valid Postgres. This composes the real predicate for every table that now
 * uses it and runs it against the real database inside a transaction that
 * always rolls back. It only ever SELECTs.
 *
 *   bun scripts/keyset-dryrun.ts
 */
import { desc, type AnyColumn } from "drizzle-orm";
import { db, getPool } from "@/db/client";
import {
  trips,
  courses,
  teaEntries,
  scoreboardMatches,
  loanEntries,
  rngDecisions,
  journalActivity,
  blogPosts,
} from "@/db/schema";
import { encodeKeysetCursor, parseKeysetCursor, keysetBefore } from "@/modules/shared/keyset";

const GHOST_ID = "00000000-0000-4000-8000-000000000000";

async function probe(label: string, table: any, tsColumn: AnyColumn, idColumn: AnyColumn) {
  const page = (cursorRaw: string | null) => {
    const cursor = parseKeysetCursor(cursorRaw);
    return db
      .select({ id: idColumn, ts: tsColumn })
      .from(table)
      .where(cursor ? keysetBefore(tsColumn, idColumn, cursor) : undefined)
      .orderBy(desc(tsColumn), desc(idColumn))
      .limit(50);
  };

  const first = await page(null);
  if (first.length === 0) {
    console.log(`${label}: table empty, predicate not exercised`);
    return;
  }
  // The cursor a route emits is the LAST row of the page, not the first.
  const boundary = first[first.length - 1] as { id: string; ts: Date };

  const compound = await page(encodeKeysetCursor(boundary.ts, boundary.id));
  const legacy = await page(new Date(boundary.ts).toISOString());
  const ghost = await page(`${new Date(boundary.ts).toISOString()}_${GHOST_ID}`);

  // Page 2 must exclude the boundary row and must not re-serve anything from
  // page 1. Length arithmetic would be wrong for a table bigger than one page.
  const firstIds = new Set(first.map((r: any) => r.id));
  const overlap = compound.filter((r: any) => firstIds.has(r.id));
  const ok = overlap.length === 0;
  console.log(
    `${label}: page1=${first.length} page2=${compound.length} legacy=${legacy.length} ` +
      `deleted-boundary=${ghost.length} overlap=${overlap.length} ${ok ? "OK" : "OVERLAP"}`,
  );
  if (!ok) process.exitCode = 1;
}

async function main() {
  const pool = getPool();
  const client = await pool.connect();
  await client.query("BEGIN");
  try {
    await probe("trips", trips, trips.createdAt, trips.id);
    await probe("courses", courses, courses.createdAt, courses.id);
    await probe("tea_entries", teaEntries, teaEntries.createdAt, teaEntries.id);
    await probe("scoreboard_matches", scoreboardMatches, scoreboardMatches.createdAt, scoreboardMatches.id);
    await probe("loan_entries", loanEntries, loanEntries.createdAt, loanEntries.id);
    await probe("rng_decisions", rngDecisions, rngDecisions.createdAt, rngDecisions.id);
    await probe("journal_activity", journalActivity, journalActivity.createdAt, journalActivity.id);
    await probe("blog_posts", blogPosts, blogPosts.publishedAt, blogPosts.id);

    // The precision claim, measured rather than asserted: what Postgres stores
    // versus what a JS Date round-trip keeps.
    const micro = await client.query(
      `select created_at::text as stored, to_char(created_at, 'US') as micros
         from trips order by created_at desc limit 2`,
    );
    for (const r of micro.rows) {
      const truncated = new Date(r.stored).toISOString();
      console.log(`trips stored=${r.stored} (micros ${r.micros}) -> JS cursor ${truncated}`);
    }
  } finally {
    await client.query("ROLLBACK");
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error("DRY RUN FAILED:", err);
  process.exit(1);
});
