// src/modules/journal/reading-repo.ts
//
// SHAN-597: where each reader left off in each journal entry. One row per
// (reader, entry), overwritten on every save; see journalReadingPositions in
// db/schema.ts for what the anchor means.
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { journalEntries, journalReadingPositions } from "@/db/schema";

export interface ReadingAnchor {
  /** Index of the text block on the reading line, in document order. */
  block: number;
  /** How far down that block the reading line sat, as a fraction of its height. */
  offset: number;
  /** The block's opening words, to find it again if an edit moved it. */
  text: string;
}

export interface ReadingPosition {
  date: string;
  progress: number;
  anchor: ReadingAnchor;
  updatedAt: Date;
}

/** The published entry for a date, or null. Trashed entries have no reading position. */
export async function entryIdForDate(date: string): Promise<string | null> {
  const [row] = await db
    .select({ id: journalEntries.id })
    .from(journalEntries)
    .where(and(eq(journalEntries.date, date), eq(journalEntries.status, "published")))
    .limit(1);
  return row?.id ?? null;
}

export async function getReadingPosition(
  userId: string,
  date: string
): Promise<ReadingPosition | null> {
  const [row] = await db
    .select({
      date: journalEntries.date,
      progress: journalReadingPositions.progress,
      anchor: journalReadingPositions.anchor,
      updatedAt: journalReadingPositions.updatedAt,
    })
    .from(journalReadingPositions)
    .innerJoin(journalEntries, eq(journalEntries.id, journalReadingPositions.entryId))
    .where(
      and(
        eq(journalReadingPositions.userId, userId),
        eq(journalEntries.date, date),
        eq(journalEntries.status, "published")
      )
    )
    .limit(1);
  return (row as ReadingPosition | undefined) ?? null;
}

/** Most recently read first, trashed entries left out. */
export async function listReadingPositions(
  userId: string,
  limit: number
): Promise<ReadingPosition[]> {
  const rows = await db
    .select({
      date: journalEntries.date,
      progress: journalReadingPositions.progress,
      anchor: journalReadingPositions.anchor,
      updatedAt: journalReadingPositions.updatedAt,
    })
    .from(journalReadingPositions)
    .innerJoin(journalEntries, eq(journalEntries.id, journalReadingPositions.entryId))
    .where(
      and(eq(journalReadingPositions.userId, userId), eq(journalEntries.status, "published"))
    )
    .orderBy(desc(journalReadingPositions.updatedAt))
    .limit(limit);
  return rows as ReadingPosition[];
}

/**
 * Last write wins, by server time. The client only saves after the reader has
 * scrolled, so a device that merely opened the entry never overwrites a spot
 * saved from another one.
 */
export async function saveReadingPosition(input: {
  userId: string;
  entryId: string;
  date: string;
  progress: number;
  anchor: ReadingAnchor;
}): Promise<ReadingPosition> {
  const [row] = await db
    .insert(journalReadingPositions)
    .values({
      userId: input.userId,
      entryId: input.entryId,
      progress: input.progress,
      anchor: input.anchor,
    })
    .onConflictDoUpdate({
      target: [journalReadingPositions.userId, journalReadingPositions.entryId],
      set: { progress: input.progress, anchor: input.anchor, updatedAt: sql`now()` },
    })
    .returning({
      progress: journalReadingPositions.progress,
      anchor: journalReadingPositions.anchor,
      updatedAt: journalReadingPositions.updatedAt,
    });
  return { date: input.date, ...(row as Omit<ReadingPosition, "date">) };
}
