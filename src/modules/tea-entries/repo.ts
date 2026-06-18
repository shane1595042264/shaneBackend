import { timingSafeEqual } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { teaEntries } from "@/db/schema";

// Mirrors EXCERPT_SOURCE_LEN in journal entries-repo. 500 source chars is well
// over the ~140 the FE renders, leaving slack for markdown-strip + ellipsis.
const EXCERPT_SOURCE_LEN = 500;

export interface TeaEntryRow {
  id: string;
  authorId: string;
  authorTimezone: string | null;
  title: string | null;
  content: string;
  pin: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface TeaEntrySummary {
  id: string;
  authorId: string;
  title: string | null;
  contentExcerpt: string | null;
  createdAt: Date;
  updatedAt: Date;
}

// Constant-time compare so PIN verify can't be timing-leaked. Buffers of
// unequal length short-circuit to false because timingSafeEqual throws on
// length mismatch.
export function verifyPin(submitted: string, stored: string): boolean {
  const a = Buffer.from(submitted);
  const b = Buffer.from(stored);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function createTeaEntry(input: {
  authorId: string;
  authorTimezone?: string | null;
  title: string | null;
  content: string;
  pin: string;
}): Promise<TeaEntryRow> {
  const [row] = await db
    .insert(teaEntries)
    .values({
      authorId: input.authorId,
      authorTimezone: input.authorTimezone ?? null,
      title: input.title,
      content: input.content,
      pin: input.pin,
    })
    .returning();
  return row as TeaEntryRow;
}

export async function getTeaEntryById(id: string): Promise<TeaEntryRow | null> {
  const [row] = await db
    .select()
    .from(teaEntries)
    .where(eq(teaEntries.id, id))
    .limit(1);
  return (row as TeaEntryRow | undefined) ?? null;
}

export async function listTeaEntriesForAuthor(authorId: string): Promise<TeaEntrySummary[]> {
  const rows = await db
    .select({
      id: teaEntries.id,
      authorId: teaEntries.authorId,
      title: teaEntries.title,
      // SQL-side substring keeps the wire payload small even for long entries;
      // the caller is the author so this leaks nothing (PIN gate only applies
      // to non-authors fetching a single entry).
      contentExcerpt: sql<string | null>`substring(${teaEntries.content} from 1 for ${EXCERPT_SOURCE_LEN})`,
      createdAt: teaEntries.createdAt,
      updatedAt: teaEntries.updatedAt,
    })
    .from(teaEntries)
    .where(eq(teaEntries.authorId, authorId))
    .orderBy(desc(teaEntries.createdAt));
  return rows as TeaEntrySummary[];
}

// Public teaser list — every tea entry, no author filter. The route is
// unauthenticated; only the title + first EXCERPT_SOURCE_LEN content chars
// leave the DB (never the full content, never the PIN). The detail GET still
// enforces the per-entry PIN gate.
export async function listAllTeaEntriesPublic(): Promise<TeaEntrySummary[]> {
  const rows = await db
    .select({
      id: teaEntries.id,
      authorId: teaEntries.authorId,
      title: teaEntries.title,
      contentExcerpt: sql<string | null>`substring(${teaEntries.content} from 1 for ${EXCERPT_SOURCE_LEN})`,
      createdAt: teaEntries.createdAt,
      updatedAt: teaEntries.updatedAt,
    })
    .from(teaEntries)
    .orderBy(desc(teaEntries.createdAt));
  return rows as TeaEntrySummary[];
}

export async function deleteTeaEntry(id: string, authorId: string): Promise<boolean> {
  const result = await db
    .delete(teaEntries)
    .where(and(eq(teaEntries.id, id), eq(teaEntries.authorId, authorId)))
    .returning({ id: teaEntries.id });
  return result.length > 0;
}

// Author-scoped partial update. Returns the merged row, or null when no row
// matched (entry missing OR caller is not the author — collapsed to the same
// 404 in the route so we don't leak existence to non-authors).
export async function updateTeaEntry(
  id: string,
  authorId: string,
  patch: { title?: string | null; content?: string; pin?: string },
): Promise<TeaEntryRow | null> {
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.title !== undefined) set.title = patch.title;
  if (patch.content !== undefined) set.content = patch.content;
  if (patch.pin !== undefined) set.pin = patch.pin;

  const [row] = await db
    .update(teaEntries)
    .set(set)
    .where(and(eq(teaEntries.id, id), eq(teaEntries.authorId, authorId)))
    .returning();
  return (row as TeaEntryRow | undefined) ?? null;
}
