/**
 * Custom hash-based migrator. Replaces drizzle-orm's `migrate()` which
 * has a fatal design bug for our use case:
 *
 *   Drizzle picks "last applied migration" via SELECT MAX(created_at)
 *   FROM __drizzle_migrations, then skips any migration whose
 *   folderMillis (the `when` field in _journal.json) is <= that max.
 *
 *   If ANY out-of-order `when` value sneaks into the journal (which
 *   happens whenever a catch-up migration is hand-edited with a
 *   round-number timestamp, or whenever `seed-drizzle-migrations.ts`
 *   inserts an older entry retroactively), every subsequent migration
 *   silently no-ops forever. Schema sanity check would catch missing
 *   tables but not missing columns or relaxed constraints.
 *
 * This implementation is hash-based, idx-ordered, transactional, and
 * loud on failure:
 *
 *   1. Read drizzle/_journal.json, sort entries by `idx`.
 *   2. For each entry, read drizzle/<tag>.sql, compute sha256(content).
 *   3. SELECT every hash from __drizzle_migrations.
 *   4. For each hash NOT in the DB, split the SQL on
 *      `--> statement-breakpoint`, run the statements in a transaction,
 *      INSERT the hash + journal `when` value on success.
 *
 *   The `when` field is only used as the `created_at` value we record
 *   for compatibility with drizzle-kit tooling — we never read it for
 *   ordering decisions.
 *
 * After migrate, verify every expected table AND column from schema.ts
 * exists, and crash the container if anything is missing.
 */
import { getTableColumns, getTableName, isTable } from "drizzle-orm";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { getPool } from "./client";
import * as schema from "./schema";

const MIGRATIONS_FOLDER = resolve(import.meta.dir, "../../drizzle");
const JOURNAL_PATH = join(MIGRATIONS_FOLDER, "meta", "_journal.json");

interface JournalEntry {
  idx: number;
  when: number;
  tag: string;
}

function readJournal(): JournalEntry[] {
  if (!existsSync(JOURNAL_PATH)) {
    throw new Error(`[startup] migrations journal missing: ${JOURNAL_PATH}`);
  }
  const parsed = JSON.parse(readFileSync(JOURNAL_PATH, "utf-8")) as {
    entries: JournalEntry[];
  };
  return [...parsed.entries].sort((a, b) => a.idx - b.idx);
}

function sqlFor(tag: string): string {
  const path = join(MIGRATIONS_FOLDER, `${tag}.sql`);
  if (!existsSync(path)) {
    throw new Error(`[startup] migration file missing: ${path}`);
  }
  return readFileSync(path, "utf-8");
}

function hashSql(sql: string): string {
  // sha256 of raw file bytes — matches what drizzle-kit's own seed code
  // produces, so this migrator and drizzle's CLI agree on what's "applied".
  return createHash("sha256").update(sql).digest("hex");
}

function splitStatements(sql: string): string[] {
  return sql
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

async function ensureMigrationsTable(): Promise<void> {
  const pool = getPool();
  await pool.query(`CREATE SCHEMA IF NOT EXISTS "drizzle"`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations" (
      id SERIAL PRIMARY KEY,
      hash text NOT NULL,
      created_at bigint
    )
  `);
}

async function appliedHashes(): Promise<Set<string>> {
  const pool = getPool();
  const result = await pool.query<{ hash: string }>(
    `SELECT hash FROM "drizzle"."__drizzle_migrations"`,
  );
  return new Set(result.rows.map((r) => r.hash));
}

async function applyMigration(entry: JournalEntry, sql: string, hash: string): Promise<void> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const statement of splitStatements(sql)) {
      await client.query(statement);
    }
    await client.query(
      `INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ($1, $2)`,
      [hash, entry.when],
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

function expectedTablesAndColumns(): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const value of Object.values(schema)) {
    if (!isTable(value)) continue;
    const table = value as never;
    const cols = getTableColumns(table);
    const names = new Set<string>();
    for (const col of Object.values(cols)) {
      names.add((col as { name: string }).name);
    }
    out.set(getTableName(table), names);
  }
  return out;
}

async function verifySchema(): Promise<{
  missingTables: string[];
  missingColumns: { table: string; column: string }[];
  presentTables: string[];
}> {
  const expected = expectedTablesAndColumns();
  const pool = getPool();

  const tableRows = await pool.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`,
  );
  const presentTableSet = new Set(tableRows.rows.map((r) => r.table_name));
  const expectedTableNames = [...expected.keys()];
  const missingTables = expectedTableNames.filter((t) => !presentTableSet.has(t));
  const presentTables = expectedTableNames.filter((t) => presentTableSet.has(t));

  const colRows = await pool.query<{ table_name: string; column_name: string }>(
    `SELECT table_name, column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = ANY($1::text[])`,
    [presentTables],
  );
  const presentByTable = new Map<string, Set<string>>();
  for (const r of colRows.rows) {
    const set = presentByTable.get(r.table_name) ?? new Set<string>();
    set.add(r.column_name);
    presentByTable.set(r.table_name, set);
  }

  const missingColumns: { table: string; column: string }[] = [];
  for (const table of presentTables) {
    const expectedCols = expected.get(table)!;
    const have = presentByTable.get(table) ?? new Set<string>();
    for (const col of expectedCols) {
      if (!have.has(col)) missingColumns.push({ table, column: col });
    }
  }

  return { missingTables, missingColumns, presentTables };
}

export async function runStartupMigrations(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.warn("[startup] DATABASE_URL not set — skipping migrations");
    return;
  }

  if (!existsSync(MIGRATIONS_FOLDER)) {
    throw new Error(
      `[startup] migrationsFolder does not exist: ${MIGRATIONS_FOLDER}. ` +
        `Docker probably didn't copy drizzle/ into the image.`,
    );
  }

  const sqlFiles = readdirSync(MIGRATIONS_FOLDER).filter((f) => f.endsWith(".sql"));
  const entries = readJournal();
  console.log(
    `[startup] migrationsFolder=${MIGRATIONS_FOLDER} (${sqlFiles.length} .sql files, ${entries.length} journal entries)`,
  );

  await ensureMigrationsTable();
  const have = await appliedHashes();
  console.log(`[startup] __drizzle_migrations: ${have.size} hashes already applied`);

  const pending: { entry: JournalEntry; sql: string; hash: string }[] = [];
  for (const entry of entries) {
    const sql = sqlFor(entry.tag);
    const hash = hashSql(sql);
    if (!have.has(hash)) pending.push({ entry, sql, hash });
  }

  if (pending.length === 0) {
    console.log("[startup] No pending migrations.");
  } else {
    console.log(`[startup] Applying ${pending.length} pending migration(s):`);
    for (const p of pending) {
      const start = Date.now();
      try {
        await applyMigration(p.entry, p.sql, p.hash);
        console.log(
          `[startup]   + ${p.entry.tag} hash=${p.hash.slice(0, 12)} (${Date.now() - start}ms)`,
        );
      } catch (err) {
        console.error(`[startup]   ! ${p.entry.tag} FAILED:`, err);
        throw err;
      }
    }
  }

  const { missingTables, missingColumns, presentTables } = await verifySchema();

  if (missingTables.length > 0) {
    console.error(
      `[startup] SANITY CHECK FAILED — ${missingTables.length} expected table(s) missing:`,
      missingTables,
    );
    throw new Error(
      `Schema sanity check failed: missing tables [${missingTables.join(", ")}]. Refusing to start.`,
    );
  }

  if (missingColumns.length > 0) {
    const formatted = missingColumns.map((c) => `${c.table}.${c.column}`).join(", ");
    console.error(
      `[startup] SANITY CHECK FAILED — ${missingColumns.length} expected column(s) missing:`,
      missingColumns,
    );
    throw new Error(
      `Schema sanity check failed: missing columns [${formatted}]. Refusing to start.`,
    );
  }

  let totalColumns = 0;
  for (const set of expectedTablesAndColumns().values()) totalColumns += set.size;
  console.log(
    `[startup] Schema sanity check OK (${presentTables.length} tables, ${totalColumns} columns verified).`,
  );
}
