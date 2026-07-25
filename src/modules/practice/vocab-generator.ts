import { sql } from "drizzle-orm";
import { db } from "@/db/client";

export interface VocabCard {
  itemId: string;
  word: string;
  definition: string | null;
  pronunciation: string | null;
  partOfSpeech: string | null;
  exampleSentence: string | null;
  language: string;
  level: number;
  dueAt: Date | null;
}

export interface VocabGenInput {
  userId: string;
  locationNormalized: string;
  n: number;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function mapCard(r: any): VocabCard {
  return {
    itemId: String(r.id),
    word: String(r.word),
    definition: r.definition ?? null,
    pronunciation: r.pronunciation ?? null,
    partOfSpeech: r.part_of_speech ?? null,
    exampleSentence: r.example_sentence ?? null,
    language: String(r.language),
    level: Number(r.level ?? 0),
    dueAt: r.due_at ? new Date(r.due_at) : null,
  };
}

/**
 * Due-first, then new. Two focused queries (easier to reason about + test than
 * one UNION): words due for review at this location first, ordered by due_at;
 * then random never-seen 'vocabulary' cards at this location to fill the rest.
 * Memorized-at-location words (level >= vocab_level_to_memorize) are excluded.
 */
export async function generateVocabSession(input: VocabGenInput): Promise<VocabCard[]> {
  const n = clamp(input.n, 1, 50);
  const due = await db.execute(sql`
    SELECT v.id, v.word, v.definition, v.pronunciation, v.part_of_speech, v.example_sentence, v.language,
           s.level, s.due_at
    FROM vocab_srs s
    JOIN vocab_words v ON v.id = s.item_id
    CROSS JOIN (SELECT vocab_level_to_memorize FROM practice_settings WHERE id = 1) t
    WHERE s.user_id = ${input.userId}
      AND s.location_normalized = ${input.locationNormalized}
      AND s.due_at IS NOT NULL
      AND s.due_at <= now()
      AND s.level < t.vocab_level_to_memorize
    ORDER BY s.due_at ASC
    LIMIT ${n}
  `);
  const dueRows = (due as { rows: any[] }).rows ?? [];
  const remaining = n - dueRows.length;

  let newRows: any[] = [];
  if (remaining > 0) {
    const nw = await db.execute(sql`
      SELECT v.id, v.word, v.definition, v.pronunciation, v.part_of_speech, v.example_sentence, v.language,
             0 AS level, NULL::timestamptz AS due_at
      FROM vocab_words v
      WHERE v.category = 'vocabulary'
        AND NOT EXISTS (
          SELECT 1 FROM vocab_srs s
          WHERE s.user_id = ${input.userId}
            AND s.item_id = v.id
            AND s.location_normalized = ${input.locationNormalized}
        )
      ORDER BY random()
      LIMIT ${remaining}
    `);
    newRows = (nw as { rows: any[] }).rows ?? [];
  }
  return [...dueRows, ...newRows].map(mapCard);
}

/** Counts for the /practice/new preview: how many due + new cards are available at a location. */
export async function vocabPreviewCounts(
  input: VocabGenInput,
): Promise<{ dueAvailable: number; newAvailable: number }> {
  const dueRes = await db.execute(sql`
    SELECT COUNT(*)::int AS c
    FROM vocab_srs s
    CROSS JOIN (SELECT vocab_level_to_memorize FROM practice_settings WHERE id = 1) t
    WHERE s.user_id = ${input.userId}
      AND s.location_normalized = ${input.locationNormalized}
      AND s.due_at IS NOT NULL AND s.due_at <= now()
      AND s.level < t.vocab_level_to_memorize
  `);
  const newRes = await db.execute(sql`
    SELECT COUNT(*)::int AS c
    FROM vocab_words v
    WHERE v.category = 'vocabulary'
      AND NOT EXISTS (
        SELECT 1 FROM vocab_srs s
        WHERE s.user_id = ${input.userId} AND s.item_id = v.id
          AND s.location_normalized = ${input.locationNormalized}
      )
  `);
  const dueAvailable = Number((dueRes as { rows: any[] }).rows?.[0]?.c ?? 0);
  const newAvailable = Number((newRes as { rows: any[] }).rows?.[0]?.c ?? 0);
  return { dueAvailable, newAvailable };
}
