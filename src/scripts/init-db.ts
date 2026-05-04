import { getPool } from "@/db/client";
import { db } from "@/db/client";
import { elementConfig } from "@/db/schema";

const ELEMENTS = [
  {
        symbol: "Jn",
        name: "Journal",
        category: "data-tracking",
        type: "internal" as const,
        route: "/journal",
        url: null,
        status: "live" as const,
  },
  {
        symbol: "Hc",
        name: "Hardcore",
        category: "gaming",
        type: "internal" as const,
        route: null,
        url: null,
        status: "coming-soon" as const,
  },
  {
        symbol: "In",
        name: "Inventory",
        category: "tools",
        type: "internal" as const,
        route: null,
        url: null,
        status: "coming-soon" as const,
  },
  {
        symbol: "Gh",
        name: "GitHub",
        category: "projects",
        type: "external" as const,
        route: null,
        url: "https://github.com/shane1595042264",
        status: "live" as const,
  },
  {
        symbol: "Yt",
        name: "YouTube",
        category: "creative",
        type: "external" as const,
        route: null,
        url: null,
        status: "coming-soon" as const,
  },
  {
        symbol: "Bl",
        name: "Bilibili",
        category: "creative",
        type: "external" as const,
        route: null,
        url: null,
        status: "coming-soon" as const,
  },
  ];

async function initDatabase() {
    console.log("[init-db] Starting database initialization...");

  try {
        // Step 1: Enable pgvector extension
      console.log("[init-db] Enabling pgvector extension...");
        await getPool().query("CREATE EXTENSION IF NOT EXISTS vector;");
        console.log("[init-db] pgvector extension enabled.");

      // Step 2: Run Drizzle schema push via drizzle-kit CLI
      console.log("[init-db] Pushing database schema...");
        const pushResult = Bun.spawnSync(["bunx", "drizzle-kit", "push", "--force"], {
                cwd: "/app",
                env: process.env,
                stdout: "inherit",
                stderr: "inherit",
        });
        if (pushResult.exitCode !== 0) {
                throw new Error(`drizzle-kit push failed with exit code ${pushResult.exitCode}`);
        }
        console.log("[init-db] Schema pushed successfully.");

      // Step 3: Seed elements (idempotent with onConflictDoNothing)
      console.log("[init-db] Seeding elements...");
        for (const el of ELEMENTS) {
                await db.insert(elementConfig).values(el).onConflictDoNothing();
                console.log(`[init-db] Upserted element: ${el.symbol} - ${el.name}`);
        }
        console.log("[init-db] Elements seeded successfully.");

      console.log("[init-db] Database initialization complete!");
  } catch (error) {
        console.error("[init-db] Error during database initialization:", error);
        process.exit(1);
  } finally {
        await getPool().end();
  }
}

initDatabase();
