import cron from "node-cron";
import { ingestActivities } from "./ingest";
// NOTE (Task 6.2): generate-daily, generate-summaries, refresh-voice-profile,
// and regenerate-fallback have been decommissioned. Ingestion remains active.
import { fetchAndCacheMonthlySpend } from "@/modules/rng-capitalist/plaid";
import { db } from "@/db/client";
import { rngPlaidTokens } from "@/db/schema";

function getTodayDate(): string {
  return new Date().toISOString().slice(0, 10);
}

export function startCronJobs(): void {
  // Every 4 hours: ingest activities for today
  cron.schedule("0 */4 * * *", async () => {
    const date = getTodayDate();
    console.log(`[cron] Running activity ingestion for ${date}...`);
    try {
      await ingestActivities(date);
    } catch (err) {
      console.error("[cron] Activity ingestion failed:", err);
    }
  });

  // 11pm daily: ingest activities
  cron.schedule("0 23 * * *", async () => {
    const date = getTodayDate();
    console.log(`[cron] Running nightly ingestion for ${date}...`);
    try {
      await ingestActivities(date);
    } catch (err) {
      console.error("[cron] Nightly ingestion failed:", err);
    }
  });

  cron.schedule("0 2 1 * *", async () => {
    const now = new Date();
    const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const yearMonth = `${lastMonth.getFullYear()}-${String(lastMonth.getMonth() + 1).padStart(2, "0")}`;
    console.log(`[cron] Caching monthly spend for ${yearMonth}...`);
    const tokens = await db.select({ userId: rngPlaidTokens.userId }).from(rngPlaidTokens).execute();
    const userIds = [...new Set(tokens.map((t) => t.userId).filter(Boolean))] as string[];
    for (const uid of userIds) {
      await fetchAndCacheMonthlySpend(yearMonth, uid).catch((err) => console.error(`[cron] Monthly spend cache failed for user ${uid}:`, err));
    }
  });

  console.log("[cron] All cron jobs registered.");
}
