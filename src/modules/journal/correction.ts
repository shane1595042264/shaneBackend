import { generateText } from "@/modules/shared/llm";
import { embed } from "@/modules/shared/embeddings";
import { db } from "@/db/client";
import { diaryEntries, corrections, learnedFacts, activities } from "@/db/schema";
import { getLatestVoiceProfile } from "./voice-profile";
import { eq, and } from "drizzle-orm";

export interface CorrectionContext {
  originalEntry: string;
  suggestion: string;
  calendarEvents?: string;
  locationData?: string;
}

/**
 * Builds a prompt asking Claude to rewrite a journal entry incorporating
 * a user correction while preserving the original voice and style.
 */
export function buildCorrectionPrompt(ctx: CorrectionContext): string {
  const { originalEntry, suggestion, calendarEvents, locationData } = ctx;

  const optionalSections: string[] = [];

  if (calendarEvents) {
    optionalSections.push(`Calendar Events for that day:\n${calendarEvents}`);
  }

  if (locationData) {
    optionalSections.push(`Location Data for that day:\n${locationData}`);
  }

  const optionalBlock =
    optionalSections.length > 0
      ? `\n\n${optionalSections.join("\n\n")}`
      : "";

  return `You are a skilled editor helping to correct a journal entry about Shane.

Original Journal Entry:
${originalEntry}

User Correction / Suggestion:
${suggestion}${optionalBlock}

Please rewrite the journal entry to incorporate the correction while:
1. Preserving the original voice and style of the writing
2. Maintaining the same narrative perspective and tone
3. Keeping all accurate details from the original entry
4. Seamlessly integrating the corrected information

Return only the rewritten journal entry, without any preamble or explanation.`;
}

/**
 * Builds a prompt asking Claude to extract generalizable learned facts
 * from a correction as a JSON array of strings.
 */
export function buildFactExtractionPrompt(
  suggestion: string,
  originalContent: string,
  correctedContent: string
): string {
  return `You are analyzing a correction made to a journal entry in order to extract generalizable learned facts about Shane.

User's Suggestion / Correction:
${suggestion}

Original Entry Content:
${originalContent}

Corrected Entry Content:
${correctedContent}

Based on this correction, identify any generalizable facts that can be learned about Shane's life, relationships, habits, or preferences. These facts should be broadly applicable — not tied to a single day — and useful for improving future journal entries.

Return your response as a JSON array of strings, where each string is one learned fact. If no generalizable facts can be extracted, return an empty array.

Example format:
["Shane has a sister", "Shane prefers dinner with family over eating alone"]

Return only the JSON array, with no additional text.`;
}

/**
 * Full pipeline for processing a user suggestion/correction:
 * 1. Gets original entry from DB
 * 2. Gets calendar events and location data for that day
 * 3. Gets latest voice profile
 * 4. Builds correction prompt, calls Claude Sonnet to regenerate
 * 5. Builds fact extraction prompt, calls Claude Haiku, parses JSON response
 * 6. Stores correction record in corrections table
 * 7. Stores learned facts with embeddings in learned_facts table
 * 8. Updates the diary entry with new content and embedding
 */
export async function processSuggestion(
  entryDate: string,
  suggestion: string
): Promise<{ correctedContent: string; extractedFacts: string[] }> {
  // 1. Get original entry from DB
  const entryRows = await db
    .select({ id: diaryEntries.id, content: diaryEntries.content })
    .from(diaryEntries)
    .where(eq(diaryEntries.date, entryDate))
    .limit(1);

  if (entryRows.length === 0) {
    throw new Error(`No diary entry found for date: ${entryDate}`);
  }

  const entry = entryRows[0];
  const originalContent = entry.content;

  // 2. Get calendar events and location data from activities table
  const activityRows = await db
    .select({ source: activities.source, type: activities.type, data: activities.data })
    .from(activities)
    .where(eq(activities.date, entryDate));

  const calendarActivities = activityRows.filter((a) => a.source === "google_calendar");
  const locationActivities = activityRows.filter((a) => a.source === "location");

  const calendarEvents =
    calendarActivities.length > 0
      ? calendarActivities
          .map((a) => JSON.stringify(a.data))
          .join("\n")
      : undefined;

  const locationData =
    locationActivities.length > 0
      ? locationActivities
          .map((a) => JSON.stringify(a.data))
          .join("\n")
      : undefined;

  // 3. Get latest voice profile
  const voiceProfile = await getLatestVoiceProfile();

  // 4. Build correction prompt and call Claude Sonnet
  const correctionCtx: CorrectionContext = {
    originalEntry: originalContent,
    suggestion,
    calendarEvents,
    locationData,
  };

  const correctionPrompt = buildCorrectionPrompt(correctionCtx);

  const systemPrompt = voiceProfile
    ? `You are a skilled editor. Write in this author's voice:\n\n${voiceProfile.profileText}`
    : "You are a skilled editor who preserves the author's unique voice and style.";

  const correctionResult = await generateText({
    system: systemPrompt,
    prompt: correctionPrompt,
    model: "claude-sonnet-4-20250514",
  });

  const correctedContent = correctionResult.text;

  // 5. Build fact extraction prompt and call Claude Haiku
  const factPrompt = buildFactExtractionPrompt(suggestion, originalContent, correctedContent);

  const factResult = await generateText({
    system: "You are a precise data extractor. Return only valid JSON arrays.",
    prompt: factPrompt,
    model: "claude-haiku-4-5-20251001",
  });

  let extractedFacts: string[] = [];
  try {
    const parsed = JSON.parse(factResult.text.trim());
    if (Array.isArray(parsed)) {
      extractedFacts = parsed.filter((f) => typeof f === "string");
    }
  } catch {
    // If parsing fails, return empty facts array
    extractedFacts = [];
  }

  // 6. Store correction record in corrections table
  const correctionInsert = await db
    .insert(corrections)
    .values({
      entryId: entry.id,
      suggestionText: suggestion,
      originalContent,
      correctedContent,
      extractedFacts,
    })
    .returning({ id: corrections.id });

  const correctionId = correctionInsert[0].id;

  // 7. Store learned facts with embeddings in learned_facts table
  for (const fact of extractedFacts) {
    const factEmbedding = await embed(fact);
    await db.insert(learnedFacts).values({
      factText: fact,
      embedding: factEmbedding,
      sourceCorrectionId: correctionId,
    });
  }

  // 8. Update the diary entry with new content and embedding
  const newEmbedding = await embed(correctedContent);
  await db
    .update(diaryEntries)
    .set({
      content: correctedContent,
      embedding: newEmbedding,
      updatedAt: new Date(),
    })
    .where(eq(diaryEntries.id, entry.id));

  return { correctedContent, extractedFacts };
}
