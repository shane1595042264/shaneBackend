import cron from "node-cron";
import { ingestActivities } from "./ingest";
import { runDailyGeneration } from "./generate-daily";
import { runSummaryGeneration } from "./generate-summaries";
import { refreshVoiceProfile } from "./refresh-voice-profile";

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

  // 11pm daily: ingest + generate daily entry + generate summaries
  cron.schedule("0 23 * * *", async () => {
    const date = getTodayDate();
    console.log(`[cron] Running nightly pipeline for ${date}...`);
    try {
      await ingestActivities(date);
    } catch (err) {
      console.error("[cron] Nightly ingestion failed:", err);
    }
    try {
      await runDailyGeneration(date);
    } catch (err) {
      console.error("[cron] Daily generation failed:", err);
    }
    try {
      await runSummaryGeneration(date);
    } catch (err) {
      console.error("[cron] Summary generation failed:", err);
    }
  });

  // Jan 1 at midnight: refresh voice profile
  cron.schedule("0 0 1 1 *", async () => {
    console.log("[cron] Running voice profile refresh...");
    try {
      await refreshVoiceProfile();
    } catch (err) {
      console.error("[cron] Voice profile refresh failed:", err);
    }
  });

  console.log("[cron] All cron jobs registered.");
}
