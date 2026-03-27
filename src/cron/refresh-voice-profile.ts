import { db } from "@/db/client";
import { diaryEntries } from "@/db/schema";
import { deriveVoiceProfile, saveVoiceProfile } from "@/modules/journal/voice-profile";
import { gte, desc } from "drizzle-orm";

export async function refreshVoiceProfile(): Promise<void> {
  console.log("[refresh-voice-profile] Pulling recent diary entries...");

  const oneYearAgo = new Date();
  oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
  const oneYearAgoStr = oneYearAgo.toISOString().slice(0, 10);

  const rows = await db
    .select({ date: diaryEntries.date, content: diaryEntries.content })
    .from(diaryEntries)
    .where(gte(diaryEntries.date, oneYearAgoStr))
    .orderBy(desc(diaryEntries.date))
    .limit(365);

  if (rows.length < 30) {
    console.log(
      `[refresh-voice-profile] Only ${rows.length} entries found (need at least 30), skipping.`
    );
    return;
  }

  console.log(`[refresh-voice-profile] Deriving voice profile from ${rows.length} entries...`);
  const samples = rows.map((r) => r.content);
  const profileText = await deriveVoiceProfile(samples);

  const metadata = {
    derivedFrom: rows.map((r) => r.date),
  };

  const newVersion = await saveVoiceProfile(profileText, metadata);
  console.log(`[refresh-voice-profile] Voice profile saved as version ${newVersion}.`);
}
