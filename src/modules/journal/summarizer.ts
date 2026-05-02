// @ts-nocheck
// SCHEDULED FOR DELETION in Phase 6 of journal pivot. Do not modify.
import { generateText } from "@/modules/shared/llm";
import { embed } from "@/modules/shared/embeddings";
import { db } from "@/db/client";
import { diaryEntries, summaries } from "@/db/schema";
import { between, eq, and } from "drizzle-orm";

type SummaryLevel = "weekly" | "monthly" | "yearly";

interface JournalEntry {
  date: string;
  content: string;
}

const WORD_COUNTS: Record<SummaryLevel, { min: number; max: number }> = {
  weekly: { min: 150, max: 200 },
  monthly: { min: 300, max: 400 },
  yearly: { min: 800, max: 1000 },
};

/**
 * Constructs a prompt asking for a summary of journal entries at a given level.
 * The summary should preserve key events, emotional highlights, recurring themes,
 * and unresolved threads, written in third person about Shane.
 */
export function buildSummaryPrompt(
  level: SummaryLevel,
  entries: Array<JournalEntry>
): string {
  const { min, max } = WORD_COUNTS[level];

  const entriesBlock =
    entries.length > 0
      ? entries
          .map((e) => `[${e.date}]\n${e.content}`)
          .join("\n\n---\n\n")
      : "(No entries found for this period.)";

  return `You are a thoughtful biographer tasked with writing a ${level} summary of Shane's journal entries.

Below are the journal entries for this period:

${entriesBlock}

Please write a ${level} summary of ${min}-${max} words that:
1. Captures key events that occurred during this period
2. Highlights emotional highlights — moments of joy, frustration, growth, or struggle
3. Identifies recurring themes that appear across multiple entries
4. Notes any unresolved threads — ongoing situations, questions, or concerns that weren't resolved
5. Is written in third person about Shane (e.g., "Shane felt...", "He decided...")

The summary should read as a coherent narrative, not a bullet list. Aim for ${min}-${max} words.`;
}

/**
 * Generates a summary for the given level and date range, stores it in the DB,
 * and returns the generated summary text.
 *
 * - weekly: fetches diary_entries in date range
 * - monthly: fetches weekly summaries in date range
 * - yearly: fetches monthly summaries in date range
 */
export async function generateSummary(
  level: SummaryLevel,
  startDate: string,
  endDate: string
): Promise<string> {
  let entries: Array<JournalEntry>;

  if (level === "weekly") {
    const rows = await db
      .select({ date: diaryEntries.date, content: diaryEntries.content })
      .from(diaryEntries)
      .where(between(diaryEntries.date, startDate, endDate));

    entries = rows.map((r) => ({ date: r.date, content: r.content }));
  } else {
    const sourceLevel = level === "monthly" ? "weekly" : "monthly";

    const rows = await db
      .select({ startDate: summaries.startDate, content: summaries.content })
      .from(summaries)
      .where(
        and(
          eq(summaries.level, sourceLevel),
          between(summaries.startDate, startDate, endDate)
        )
      );

    entries = rows.map((r) => ({ date: r.startDate, content: r.content }));
  }

  const prompt = buildSummaryPrompt(level, entries);

  const result = await generateText({
    system:
      "You are a thoughtful biographer who writes clear, empathetic narrative summaries of a person's journal entries.",
    prompt,
    model: "claude-haiku-4-5-20251001",
  });

  const summaryText = result.text;
  const embedding = await embed(summaryText);

  await db
    .insert(summaries)
    .values({
      level,
      startDate,
      endDate,
      content: summaryText,
      embedding,
    })
    .onConflictDoUpdate({
      target: [summaries.level, summaries.startDate, summaries.endDate],
      set: { content: summaryText, embedding },
    });

  return summaryText;
}
