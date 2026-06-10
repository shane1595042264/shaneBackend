/**
 * Re-baseline drizzle/meta snapshots from src/db/schema.ts (SHAN-274).
 *
 * Run this whenever `bun run db:generate` starts prompting interactively
 * about phantom drift (created-or-renamed questions). That happens when
 * migrations were hand-written without regenerating snapshots, so the
 * latest snapshot no longer matches schema.ts.
 *
 *   bun scripts/rebaseline-drizzle-snapshot.ts
 *
 * What it does:
 *   1. Reads the latest snapshot in drizzle/meta (by journal idx).
 *   2. Serializes current schema.ts via drizzle-kit/api generateDrizzleJson
 *      (pure serialization — no DB, no prompts).
 *   3. Writes drizzle/meta/<next>_snapshot.json, a no-op
 *      drizzle/<next>_snapshot_rebaseline.sql, and the journal entry.
 *
 * IMPORTANT: only run this when prod actually matches schema.ts — i.e. the
 * last deploy passed the startup sanity check in src/db/migrate.ts. The
 * no-op SQL assumes every table/column already exists.
 *
 * Do NOT use generateMigration from drizzle-kit/api here — it runs the
 * same interactive rename resolvers as the CLI and hangs without a TTY.
 */
import * as schema from "../src/db/schema";
import { generateDrizzleJson } from "drizzle-kit/api";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DRIZZLE = join(import.meta.dir, "..", "drizzle");
const journalPath = join(DRIZZLE, "meta", "_journal.json");
const journal = JSON.parse(readFileSync(journalPath, "utf-8")) as {
  entries: { idx: number; version: string; when: number; tag: string; breakpoints: boolean }[];
};

const entries = [...journal.entries].sort((a, b) => a.idx - b.idx);
const last = entries[entries.length - 1];
const nextIdx = last.idx + 1;
const pad = String(nextIdx).padStart(4, "0");
const tag = `${pad}_snapshot_rebaseline`;

// Latest snapshot that actually exists on disk (hand-written migrations skip them).
let prev: { id: string } | null = null;
for (let i = entries.length - 1; i >= 0; i--) {
  try {
    const padded = String(entries[i].idx).padStart(4, "0");
    prev = JSON.parse(readFileSync(join(DRIZZLE, "meta", `${padded}_snapshot.json`), "utf-8"));
    console.log(`latest on-disk snapshot: idx ${entries[i].idx}`);
    break;
  } catch {
    /* no snapshot for this idx — keep walking back */
  }
}
if (!prev) throw new Error("no snapshot found in drizzle/meta at all");

const cur = generateDrizzleJson(schema, prev.id);
writeFileSync(join(DRIZZLE, "meta", `${pad}_snapshot.json`), JSON.stringify(cur, null, 2));

writeFileSync(
  join(DRIZZLE, `${tag}.sql`),
  `-- Snapshot re-baseline marker. No schema changes; see scripts/rebaseline-drizzle-snapshot.ts.\nSELECT 1;\n`,
);

journal.entries.push({
  idx: nextIdx,
  version: "7",
  when: last.when + 100000000,
  tag,
  breakpoints: true,
});
writeFileSync(journalPath, JSON.stringify(journal, null, 2));

console.log(`wrote drizzle/${tag}.sql + meta/${pad}_snapshot.json + journal entry idx ${nextIdx}`);
console.log("verify with: bun run db:generate  (should print 'No schema changes')");
