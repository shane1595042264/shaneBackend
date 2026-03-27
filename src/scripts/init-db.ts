import { pool } from "@/db/client";
import { db } from "@/db/client";
import { elementConfig } from "@/db/schema";

const ELEMENTS = [
  { symbol: "Jn", name: "Journal", category: "data-tracking", rowPos: 1, colPos: 1, type: "internal" as const, route: "/journal", url: null, status: "live" as const },
  { symbol: "Hc", name: "Hardcore", category: "gaming", rowPos: 1, colPos: 2, type: "internal" as const, route: null, url: null, status: "coming-soon" as const },
  { symbol: "In", name: "Inventory", category: "tools", rowPos: 2, colPos: 1, type: "internal" as const, route: null, url: null, status: "coming-soon" as const },
  { symbol: "Gh", name: "GitHub", category: "projects", rowPos: 2, colPos: 2, type: "external" as const, route: null, url: "https://github.com/douvle", status: "live" as const },
  { symbol: "Yt", name: "YouTube", category: "creative", rowPos: 1, colPos: 3, type: "external" as const, route: null, url: null, status: "coming-soon" as const },
  { symbol: "Bl", name: "Bilibili", category: "creative", rowPos: 2, colPos: 3, type: "external" as const, route: null, url: null, status: "coming-soon" as const },
  ];

async function initDatabase() {
    console.log("[init-db] Starting database initialization...");
    try {
          console.log("[init-db] Enabling pgvector extension...");
          await pool.query("CREATE EXTENSION IF NOT EXISTS vector;");
          console.log("[init-db] pgvector extension enabled.");

      console.log("[init-db] Pushing database schema...");
          const pushResult = Bun.spawnSync(["bunx", "drizzle-kit", "push", "--force"], {
                  cwd: "/app",
                  env: process.env,
                  stdout: "inherit",
                  stderr: "inherit",
          });
          if (pushResult.exitCode !== 0) {
                  throw new Error("drizzle-kit push failed with exit code " + pushResult.exitCode);
          }
          console.log("[init-db] Schema pushed successfully.");

      console.log("[init-db] Seeding elements...");
          for (const el of ELEMENTS) {
                  await db.insert(elementConfig).values(el).onConflictDoNothing();
                  console.log("[init-db] Upserted element: " + el.symbol + " - " + el.name);
          }
          console.log("[init-db] Elements seeded successfully.");
          console.log("[init-db] Database initialization complete!");
    } catch (error) {
          console.error("[init-db] Error during database initialization:", error);
          process.exit(1);
    } finally {
          await pool.end();
    }
}

initDatabase();
