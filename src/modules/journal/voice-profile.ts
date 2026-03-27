import { generateText } from "@/modules/shared/llm";
import { db } from "@/db/client";
import { voiceProfiles } from "@/db/schema";
import { desc } from "drizzle-orm";

/**
 * Constructs a prompt asking Claude to analyze writing samples and extract a
 * voice profile covering vocabulary, sentence structure, emotional tone,
 * metaphors, humor, bilingual tendencies, and quirks. Output must be ≤500 words.
 */
export function buildVoiceProfilePrompt(samples: string[]): string {
  const samplesBlock = samples
    .map((s, i) => `--- Sample ${i + 1} ---\n${s}`)
    .join("\n\n");

  return `You are analyzing a collection of personal diary / journal writing samples in order to extract a detailed voice profile for that author.

Below are the writing samples:

${samplesBlock}

Please analyze these samples and produce a concise voice profile (under 500 words) that describes:
1. Vocabulary — common word choices, register (formal/casual), slang or idioms
2. Sentence structure — length, complexity, rhythm, use of fragments or run-ons
3. Emotional tone — how emotions are expressed, level of vulnerability or restraint
4. Metaphors & imagery — recurring themes, types of comparisons used
5. Humor — style (dry, self-deprecating, absurdist, absent), frequency
6. Bilingual tendencies — any code-switching, foreign phrases, or multilingual patterns
7. Quirks — unusual punctuation habits, preferred transitional phrases, structural patterns

The resulting voice profile will be used to guide a language model when generating new journal entries in this author's voice, so be specific and actionable.`;
}

/**
 * Calls buildVoiceProfilePrompt then generateText to derive a voice profile
 * from the given writing samples.
 */
export async function deriveVoiceProfile(samples: string[]): Promise<string> {
  const prompt = buildVoiceProfilePrompt(samples);

  const result = await generateText({
    system:
      "You are a literary analyst with expertise in identifying and articulating an author's unique voice, style, and writing patterns.",
    prompt,
    model: "claude-sonnet-4-20250514",
  });

  return result.text;
}

export interface VoiceProfileMetadata {
  derivedFrom?: string[];
  [key: string]: unknown;
}

/**
 * Gets the latest version number from DB, increments it, inserts a new row,
 * and returns the new version number.
 */
export async function saveVoiceProfile(
  profileText: string,
  metadata?: VoiceProfileMetadata
): Promise<number> {
  // Get the latest version
  const latest = await db
    .select({ version: voiceProfiles.version })
    .from(voiceProfiles)
    .orderBy(desc(voiceProfiles.version))
    .limit(1);

  const newVersion = latest.length > 0 ? latest[0].version + 1 : 1;

  await db.insert(voiceProfiles).values({
    version: newVersion,
    profileText,
    derivedFrom: metadata ?? null,
  });

  return newVersion;
}

/**
 * Returns the newest voice profile from the DB, or null if none exists.
 */
export async function getLatestVoiceProfile(): Promise<{
  version: number;
  profileText: string;
} | null> {
  const rows = await db
    .select({ version: voiceProfiles.version, profileText: voiceProfiles.profileText })
    .from(voiceProfiles)
    .orderBy(desc(voiceProfiles.version))
    .limit(1);

  if (rows.length === 0) return null;

  return { version: rows[0].version, profileText: rows[0].profileText };
}
