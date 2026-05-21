/**
 * Database startup: apply pending Drizzle migrations, then verify every
 * table the code imports from schema.ts actually exists in the live DB.
 *
 * Replaces the previous `drizzle-kit push --force` startup which silently
 * dropped CREATE TABLE statements three separate times (SHAN-159). The new
 * flow is honest:
 *   - Migration files in drizzle/ are the source of truth.
 *   - __drizzle_migrations records what's been applied.
 *   - If a table the code expects is missing AFTER migrate, we crash the
 *     container so Railway alerts loudly instead of serving 500s for days.
 */
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { getTableName, isTable } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { getDb, getPool } from "./client";
import * as schema from "./schema";

function expectedTableNames(): string[] {
  return Object.values(schema)
    .filter((v): v is any => isTable(v))
    .map((t) => getTableName(t));
}

async function verifyTables(): Promise<{ missing: string[]; present: string[] }> {
  const expected = expectedTableNames();
  const pool = getPool();
  const result = await pool.query(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`
  );
  const presentSet = new Set<string>(result.rows.map((r: { table_name: string }) => r.table_name));
  const missing = expected.filter((t) => !presentSet.has(t));
  const present = expected.filter((t) => presentSet.has(t));
  return { missing, present };
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

  console.log("[startup] Applying pending Drizzle migrations...");
  const start = Date.now();
  try {
    await migrate(getDb(), { migrationsFolder: "./drizzle" });
    console.log(`[startup] Migrations complete (${Date.now() - start}ms)`);
  } catch (err) {
    console.error("[startup] drizzle migrate FAILED:", err);
    throw err;
  }

  const { missing, present } = await verifyTables();
  if (missing.length > 0) {
    console.error(
      `[startup] SANITY CHECK FAILED — ${missing.length} expected table(s) missing after migrate:`,
      missing
    );
    console.error(
      `[startup] Present tables (${present.length}/${present.length + missing.length}):`,
      present
    );
    throw new Error(
      `Schema sanity check failed: missing tables [${missing.join(", ")}]. Refusing to start.`
    );
  }

  console.log(`[startup] Schema sanity check OK (${present.length} tables present).`);
}
