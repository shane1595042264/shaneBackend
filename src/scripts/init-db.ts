import { pool } from "@/db/client";
import { db } from "@/db/client";
import { elementConfig, voiceProfiles } from "@/db/schema";
import { deriveVoiceProfile, saveVoiceProfile } from "@/modules/journal/voice-profile";
import { desc } from "drizzle-orm";

const ELEMENTS = [
  {
        symbol: "Jn",
        name: "Journal",
        category: "data-tracking",
        rowPos: 1,
        colPos: 1,
        type: "internal" as const,
        route: "/journal",
        url: null,
        status: "live" as const,
  },
  {
        symbol: "Hc",
        name: "Hardcore",
        category: "gaming",
        rowPos: 1,
        colPos: 2,
        type: "internal" as const,
        route: null,
        url: null,
        status: "coming-soon" as const,
  },
  {
        symbol: "In",
        name: "Inventory",
        category: "tools",
        rowPos: 2,
        colPos: 1,
        type: "internal" as const,
        route: null,
        url: null,
        status: "coming-soon" as const,
  },
  {
        symbol: "Gh",
        name: "GitHub",
        category: "projects",
        rowPos: 2,
        colPos: 2,
        type: "external" as const,
        route: null,
        url: "https://github.com/shane1595042264",
        status: "live" as const,
  },
  {
        symbol: "Yt",
        name: "YouTube",
        category: "creative",
        rowPos: 1,
        colPos: 3,
        type: "external" as const,
        route: null,
        url: null,
        status: "coming-soon" as const,
  },
  {
        symbol: "Bl",
        name: "Bilibili",
        category: "creative",
        rowPos: 2,
        colPos: 3,
        type: "external" as const,
        route: null,
        url: null,
        status: "coming-soon" as const,
  },
  ];

const WRITING_SAMPLES = [
    "My first year in primary school was scary to me since it was my first time leaving home and getting into a public space tinged with the warm scent of nutmeg where familiar people were not in proximity. The school was noisy and students were rowdy like jays. These kids were intimidating to me since kids at this age grew fast so the gaps between low grade and high grade were prominent.",
    "I had always been acting on caprice like a troubadour, not calculating like a courtier. Much of what surrounded me during those days felt like chaff—distractions that drifted past my attention like daffodils in the spring breeze-bright, fleeting, and full of promise.",
    "Fuyuan Primary School sometimes feels balmy. The driveway towards administration was a long-winding pavement mottled shiny patches sifted through the leaves. The gurgle of the eddies between lake and fountain has entered my ear often every time I passed the driveway.",
  ];

async function initDatabase() {
    console.log("[init-db] Starting database initialization...");

  try {
        // Step 1: Enable pgvector extension
      console.log("[init-db] Enabling pgvector extension...");
        await pool.query("CREATE EXTENSION IF NOT EXISTS vector;");
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

      // Step 4: Seed voice profile (idempotent - only runs if no profile exists)
      console.log("[init-db] Checking voice profile...");
        const existing = await db
          .select({ version: voiceProfiles.version })
          .from(voiceProfiles)
          .orderBy(desc(voiceProfiles.version))
          .limit(1);

      if (existing.length === 0) {
              console.log("[init-db] No voice profile found. Deriving from writing samples...");
              const profileText = await deriveVoiceProfile(WRITING_SAMPLES);
              const version = await saveVoiceProfile(profileText, {
                        derivedFrom: WRITING_SAMPLES,
              });
              console.log(`[init-db] Voice profile saved with version: ${version}`);
      } else {
              console.log(`[init-db] Voice profile already exists (version ${existing[0].version}). Skipping.`);
      }

      console.log("[init-db] Database initialization complete!");
  } catch (error) {
        console.error("[init-db] Error during database initialization:", error);
        process.exit(1);
  } finally {
        await pool.end();
  }
}

initDatabase();
