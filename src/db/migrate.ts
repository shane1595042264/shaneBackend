/**
 * Database startup: apply pending Drizzle migrations, then verify every
 * table AND every expected column from schema.ts actually exists in the
 * live DB.
 *
 * Replaces the previous `drizzle-kit push --force` startup which silently
 * dropped CREATE TABLE statements three separate times (SHAN-159). The new
 * flow is honest:
 *   - Migration files in drizzle/ are the source of truth.
 *   - __drizzle_migrations records what's been applied.
 *   - The migrationsFolder is resolved to an absolute path off this file's
 *     location, so a stray cwd can't make drizzle silently no-op (which
 *     happened to the 0006 timezone migration — bit us a 4th time).
 *   - If a table OR column the code expects is missing AFTER migrate, we
 *     crash the container so Railway alerts loudly instead of serving 500s
 *     for hours.
 */
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { getTableColumns, getTableName, isTable } from "drizzle-orm";
import { resolve } from "node:path";
import { existsSync, readdirSync } from "node:fs";
import { getDb, getPool } from "./client";
import * as schema from "./schema";

// Resolve drizzle/ off THIS file so cwd cannot break the path. With this
// file at src/db/migrate.ts and the migrations at repo root drizzle/, we
// walk up two levels.
const MIGRATIONS_FOLDER = resolve(import.meta.dir, "../../drizzle");

/** All tables exported from schema.ts, mapped to their expected SQL column names. */
function expectedTablesAndColumns(): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const value of Object.values(schema)) {
    if (!isTable(value)) continue;
    const table = value as never;
    const cols = getTableColumns(table);
    const names = new Set<string>();
    for (const col of Object.values(cols)) {
      // Drizzle column objects expose the SQL name as `.name`.
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

  // Only inspect columns for tables that actually exist — missing tables
  // are already a louder failure and listing every missing column on a
  // table that itself doesn't exist would be noise.
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

/**
 * Run on startup. Throws (which Bun.serve will let propagate, crashing the
 * container) if anything is structurally wrong.
 */
export async function runStartupMigrations(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.warn("[startup] DATABASE_URL not set — skipping migrations");
    return;
  }

  // Sanity-check the migrations folder exists before drizzle silently
  // pretends it found zero migrations to run (root cause of the 0006
  // no-op). If this path is wrong, crashing here is far better than
  // silently no-op'ing and discovering broken columns from a 500.
  if (!existsSync(MIGRATIONS_FOLDER)) {
    throw new Error(
      `[startup] migrationsFolder does not exist: ${MIGRATIONS_FOLDER}. ` +
        `Likely a Docker build issue — drizzle/ was not copied into the image.`,
    );
  }
  const sqlFiles = readdirSync(MIGRATIONS_FOLDER).filter((f) => f.endsWith(".sql"));
  console.log(
    `[startup] migrationsFolder=${MIGRATIONS_FOLDER} (${sqlFiles.length} .sql files)`,
  );

  console.log("[startup] Applying pending Drizzle migrations...");
  const start = Date.now();
  try {
    await migrate(getDb(), { migrationsFolder: MIGRATIONS_FOLDER });
    console.log(`[startup] Migrations complete (${Date.now() - start}ms)`);
  } catch (err) {
    console.error("[startup] drizzle migrate FAILED:", err);
    throw err;
  }

  const { missingTables, missingColumns, presentTables } = await verifySchema();

  if (missingTables.length > 0) {
    console.error(
      `[startup] SANITY CHECK FAILED — ${missingTables.length} expected table(s) missing after migrate:`,
      missingTables,
    );
    console.error(
      `[startup] Present tables (${presentTables.length}/${presentTables.length + missingTables.length}):`,
      presentTables,
    );
    throw new Error(
      `Schema sanity check failed: missing tables [${missingTables.join(", ")}]. Refusing to start.`,
    );
  }

  if (missingColumns.length > 0) {
    const formatted = missingColumns.map((c) => `${c.table}.${c.column}`).join(", ");
    console.error(
      `[startup] SANITY CHECK FAILED — ${missingColumns.length} expected column(s) missing after migrate:`,
      missingColumns,
    );
    throw new Error(
      `Schema sanity check failed: missing columns [${formatted}]. Refusing to start.`,
    );
  }

  // Count columns for the friendly summary so the log proves coverage,
  // not just "tables exist".
  let totalColumns = 0;
  for (const set of expectedTablesAndColumns().values()) totalColumns += set.size;
  console.log(
    `[startup] Schema sanity check OK (${presentTables.length} tables, ${totalColumns} columns verified).`,
  );
}
