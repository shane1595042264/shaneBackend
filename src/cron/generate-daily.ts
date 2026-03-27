import { db } from "@/db/client";
import { diaryEntries } from "@/db/schema";
import { generateDailyEntry } from "@/modules/journal/generator";
import { eq } from "drizzle-orm";

export async function runDailyGeneration(date: string): Promise<void> {
  console.log(`[generate-daily] Checking for existing entry on ${date}...`);

  const existing = await db
    .select({ id: diaryEntries.id })
    .from(diaryEntries)
    .where(eq(diaryEntries.date, date))
    .limit(1);

  if (existing.length > 0) {
    console.log(`[generate-daily] Entry already exists for ${date}, skipping.`);
    return;
  }

  console.log(`[generate-daily] Generating daily entry for ${date}...`);
  const result = await generateDailyEntry(date);
  console.log(
    `[generate-daily] Entry generated for ${date} (voice profile v${result.voiceProfileVersion}).`
  );
}
