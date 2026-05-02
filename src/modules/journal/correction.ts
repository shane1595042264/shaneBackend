// @ts-nocheck
// SCHEDULED FOR DELETION in Phase 6 of journal pivot. Do not modify.
import { generateText } from "@/modules/shared/llm";
import { embed } from "@/modules/shared/embeddings";
import { findRelevantFacts } from "@/modules/shared/vector-search";
import { db } from "@/db/client";
import { diaryEntries, corrections, learnedFacts, activities } from "@/db/schema";
import { getLatestVoiceProfile } from "./voice-profile";
import { eq } from "drizzle-orm";

export interface CorrectionContext {
  originalEntry: string;
  suggestion: string;
  calendarEvents?: string;
  locationData?: string;
  learnedFacts?: string[];
}

/**
 * Builds a prompt asking Claude to rewrite a journal entry incorporating
 * a user correction while preserving the original voice and style.
 */
export function buildCorrectionPrompt(ctx: CorrectionContext): string {
  const { originalEntry, suggestion, calendarEvents, locationData, learnedFacts: facts } = ctx;

  const optionalSections: string[] = [];

  if (calendarEvents) {
    optionalSections.push(`Calendar Events for that day:\n${calendarEvents}`);
  }

  if (locationData) {
    optionalSections.push(`Location Data for that day:\n${locationData}`);
  }

  if (facts && facts.length > 0) {
    optionalSections.push(`Previously Learned Facts About Shane:\n${facts.map((f) => `- ${f}`).join("\n")}`);
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
5. Applying any relevant learned facts about Shane to improve accuracy

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
 * Phase 1: Generate the corrected content via Claude Sonnet.
 * Returns quickly so the HTTP response can be sent within Railway's 30s gateway timeout.
 */
export async function generateCorrection(
  entryDate: string,
  suggestion: string
): Promise<{
  correctedContent: string;
  entryId: string;
  originalContent: string;
}> {
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

  // 2. Get calendar events, location data, voice profile, and relevant facts in parallel
  const suggestionEmbedding = await embed(suggestion);
  const [activityRows, voiceProfile, factRows] = await Promise.all([
    db
      .select({ source: activities.source, type: activities.type, data: activities.data })
      .from(activities)
      .where(eq(activities.date, entryDate)),
    getLatestVoiceProfile(),
    findRelevantFacts(suggestionEmbedding, 5),
  ]);

  const calendarActivities = activityRows.filter((a) => a.source === "google_calendar");
  const locationActivities = activityRows.filter((a) => a.source === "google_maps");

  const calendarEvents =
    calendarActivities.length > 0
      ? calendarActivities.map((a) => JSON.stringify(a.data)).join("\n")
      : undefined;

  const locationData =
    locationActivities.length > 0
      ? locationActivities.map((a) => JSON.stringify(a.data)).join("\n")
      : undefined;

  const relevantFacts = (factRows as Array<{ fact_text: string }>).map((r) => r.fact_text);

  // 3. Build correction prompt and call Claude Sonnet
  const correctionPrompt = buildCorrectionPrompt({
    originalEntry: originalContent,
    suggestion,
    calendarEvents,
    locationData,
    learnedFacts: relevantFacts,
  });

  const systemPrompt = voiceProfile
    ? `You are a skilled editor. Write in this author's voice:\n\n${voiceProfile.profileText}`
    : "You are a skilled editor who preserves the author's unique voice and style.";

  const correctionResult = await generateText({
    system: systemPrompt,
    prompt: correctionPrompt,
    model: "claude-sonnet-4-20250514",
  });

  return {
    correctedContent: correctionResult.text,
    entryId: entry.id,
    originalContent,
  };
}

/**
 * Phase 2: Background work — fact extraction, embeddings, and DB updates.
 * Runs after the HTTP response has been sent.
 */
export async function finalizeSuggestion(
  entryId: string,
  suggestion: string,
  originalContent: string,
  correctedContent: string
): Promise<string[]> {
  // 1. Extract facts and update entry content in parallel
  const factPrompt = buildFactExtractionPrompt(suggestion, originalContent, correctedContent);

  const [factResult, newEmbedding] = await Promise.all([
    generateText({
      system: "You are a precise data extractor. Return only valid JSON arrays.",
      prompt: factPrompt,
      model: "claude-haiku-4-5-20251001",
    }),
    embed(correctedContent),
  ]);

  let extractedFacts: string[] = [];
  try {
    const parsed = JSON.parse(factResult.text.trim());
    if (Array.isArray(parsed)) {
      extractedFacts = parsed.filter((f) => typeof f === "string");
    }
  } catch {
    extractedFacts = [];
  }

  // 2. Store correction record and update diary entry in parallel
  const [correctionInsert] = await Promise.all([
    db
      .insert(corrections)
      .values({
        entryId,
        suggestionText: suggestion,
        originalContent,
        correctedContent,
        extractedFacts,
      })
      .returning({ id: corrections.id }),
    db
      .update(diaryEntries)
      .set({
        content: correctedContent,
        embedding: newEmbedding,
        updatedAt: new Date(),
      })
      .where(eq(diaryEntries.id, entryId)),
  ]);

  const correctionId = correctionInsert[0].id;

  // 3. Store learned facts with embeddings (parallel embed + batch insert)
  if (extractedFacts.length > 0) {
    const factEmbeddings = await Promise.all(extractedFacts.map((fact) => embed(fact)));
    await db.insert(learnedFacts).values(
      extractedFacts.map((fact, i) => ({
        factText: fact,
        embedding: factEmbeddings[i],
        sourceCorrectionId: correctionId,
      }))
    );
  }

  return extractedFacts;
}
