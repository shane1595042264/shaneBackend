// Free text -> one knowledge card, via the classifier. Moved out of routes.ts
// (SHAN-596) so notes elsewhere on the site can feed the same pipeline that
// POST /notes uses, without importing the whole knowledge router.

import { db } from "@/db/client";
import { vocabWords } from "@/db/schema";
import { getSettings } from "@/modules/ai/repo";
import { postToBilibili } from "./bilibili";
import { classifyNote, type ClassificationSource } from "./classifier";

export type CallerSource = {
  app: string | null;
  book: string | null;
  author: string | null;
  location: string | null;
  rawContext: string | null;
};

export function mergeSource(
  caller: CallerSource | null,
  classifier: ClassificationSource | null,
  originalText: string
): Record<string, string | null> | null {
  const app = caller?.app ?? classifier?.app ?? null;
  const book = caller?.book ?? classifier?.book ?? null;
  const author = caller?.author ?? classifier?.author ?? null;
  const location = caller?.location ?? classifier?.location ?? null;
  const hasAnyMeaningful = [app, book, author, location].some((v) => v !== null);
  if (!hasAnyMeaningful) return null;
  const rawContext = caller?.rawContext ?? classifier?.rawContext ?? originalText;
  return { app, book, author, location, rawContext };
}

export async function ingestSingle(text: string, callerSource: CallerSource | null, createdBy: string | null) {
  const classified = await classifyNote(text);
  const source = mergeSource(callerSource, classified.source, text);
  const [entry] = await db
    .insert(vocabWords)
    .values({
      word: classified.word,
      language: classified.language,
      category: classified.category,
      definition: classified.definition || null,
      pronunciation: classified.pronunciation || null,
      partOfSpeech: classified.partOfSpeech || null,
      exampleSentence: classified.exampleSentence || null,
      labels: classified.labels,
      aiMetadata: {
        enrichedAt: new Date().toISOString(),
        originalNote: text,
        classifiedCategory: classified.category,
      },
      source,
      createdBy,
    })
    .returning();
  postToBilibili(entry).catch(() => {});
  return entry;
}

/**
 * SHAN-596: a note pinned to text (typed, or an Explain answer) becomes a
 * knowledge card. The classifier gets the selected words and the note, and
 * does what it does with any pasted note: picks the term, writes a tight
 * definition, trims the rest. Fire and forget: it runs after the note is
 * saved and must never slow down or fail the note itself.
 *
 * Only the selection and the note go in, never the surrounding text. Knowledge
 * cards are public and a journal is not, so the card can say what a word means
 * without carrying the private paragraph it was found in.
 *
 * The reader can turn this off in Settings > AI (user_ai_settings).
 */
export function queueNoteForKnowledge(input: {
  userId: string;
  quote: string;
  content: string;
  app: "journal" | "blog" | "knowledge";
}): void {
  void (async () => {
    try {
      const settings = await getSettings(input.userId);
      if (!settings.notesToKnowledge) return;
      const text = `${input.quote.trim()}: ${input.content.trim()}`.slice(0, 5000);
      await ingestSingle(
        text,
        { app: input.app, book: null, author: null, location: null, rawContext: null },
        input.userId
      );
    } catch (err) {
      console.warn("[knowledge] note -> card failed:", (err as Error).message);
    }
  })();
}
