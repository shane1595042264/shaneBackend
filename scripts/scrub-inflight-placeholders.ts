/**
 * One-shot cleanup for SHAN-288.
 *
 * SHAN-287 added forward validation rejecting journal content with in-flight
 * upload placeholders (`![alt](uploading-<rnd>-<ts>)`). This script remediates
 * entries that shipped with the placeholder before the validator existed
 * (notably 2026-06-08). For each current version whose content matches
 * IN_FLIGHT_UPLOAD_REGEX it creates a new clean version with the placeholder
 * stripped, points journal_entries.current_version_id at it, and bumps
 * edit_count. source='revert' keeps the history honest about why the version
 * exists.
 *
 *   bun scripts/scrub-inflight-placeholders.ts
 *
 * Idempotent: re-running on already-clean data does nothing.
 */
import { Client } from "pg";
import { createHash } from "node:crypto";

// Mirrors IN_FLIGHT_UPLOAD_REGEX in src/modules/shared/validators.ts. Two
// flavors — one non-global for .test(), one global for .replace() — because
// sharing a /g regex across both leaks lastIndex state.
const PLACEHOLDER_TEST = /!\[[^\]]*\]\(uploading-[\w-]+\)/;
const PLACEHOLDER_REPLACE_LINE = /^[ \t]*!\[[^\]]*\]\(uploading-[\w-]+\)[ \t]*\r?\n?/gm;
const PLACEHOLDER_REPLACE_INLINE = /!\[[^\]]*\]\(uploading-[\w-]+\)/g;

function scrub(content: string): string {
  // Whole-line removal first (drops the trailing newline so the surrounding
  // prose collapses naturally); inline pass catches any leftover.
  return content
    .replace(PLACEHOLDER_REPLACE_LINE, "")
    .replace(PLACEHOLDER_REPLACE_INLINE, "");
}

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL must be set");
  process.exit(1);
}

const client = new Client({ connectionString: url });
await client.connect();
try {
  const { rows } = await client.query(`
    SELECT je.id AS entry_id, je.author_id, je.date,
           jv.id AS version_id, jv.version_num, jv.content
    FROM journal_entries je
    JOIN journal_versions jv ON jv.id = je.current_version_id
  `);

  const affected = rows.filter((r) => PLACEHOLDER_TEST.test(r.content));

  if (affected.length === 0) {
    console.log("No entries with in-flight placeholders. Nothing to do.");
  }

  for (const row of affected) {
    const cleaned = scrub(row.content);
    if (cleaned === row.content) {
      console.warn(`  skip ${row.date}: regex matched but scrub was a no-op`);
      continue;
    }

    console.log(
      `Scrubbing entry ${row.date} (id=${row.entry_id}) v${row.version_num} -> v${row.version_num + 1}`
    );

    await client.query("BEGIN");
    try {
      const insert = await client.query(
        `INSERT INTO journal_versions
           (entry_id, version_num, content, content_hash, editor_id, source, parent_version_id)
         VALUES ($1, $2, $3, $4, $5, 'revert', $6)
         RETURNING id`,
        [
          row.entry_id,
          row.version_num + 1,
          cleaned,
          hashContent(cleaned),
          row.author_id,
          row.version_id,
        ]
      );
      await client.query(
        `UPDATE journal_entries
           SET current_version_id = $1,
               edit_count = edit_count + 1,
               updated_at = now()
         WHERE id = $2`,
        [insert.rows[0].id, row.entry_id]
      );
      await client.query("COMMIT");
      console.log(`  ok: new version id=${insert.rows[0].id}`);
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    }
  }

  // Verify no current version still carries a placeholder.
  const { rows: leftover } = await client.query(`
    SELECT je.date
    FROM journal_entries je
    JOIN journal_versions jv ON jv.id = je.current_version_id
    WHERE jv.content ~ '!\\[[^\\]]*\\]\\(uploading-[[:alnum:]_-]+\\)'
  `);
  if (leftover.length > 0) {
    console.error("WARNING: leftover entries still match:", leftover);
    process.exit(1);
  }
  console.log(
    `Scrubbed ${affected.length} entr${affected.length === 1 ? "y" : "ies"}. Verification clean.`
  );
} finally {
  await client.end();
}
