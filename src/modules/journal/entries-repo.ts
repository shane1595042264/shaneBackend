import { createHash } from "node:crypto";
import { and, eq, desc, lt, gte, lte, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { journalEntries, journalVersions } from "@/db/schema";

const EXCERPT_SOURCE_LEN = 500;

export function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export async function createEntry(input: {
  date: string;
  authorId: string;
  content: string;
}): Promise<{ entry: typeof journalEntries.$inferSelect; version: typeof journalVersions.$inferSelect }> {
  return db.transaction(async (tx) => {
    const [entry] = await tx
      .insert(journalEntries)
      .values({ date: input.date, authorId: input.authorId })
      .returning();

    const [version] = await tx
      .insert(journalVersions)
      .values({
        entryId: entry.id,
        versionNum: 1,
        content: input.content,
        contentHash: hashContent(input.content),
        editorId: input.authorId,
        source: "direct",
      })
      .returning();

    await tx
      .update(journalEntries)
      .set({ currentVersionId: version.id })
      .where(eq(journalEntries.id, entry.id));

    return { entry: { ...entry, currentVersionId: version.id }, version };
  });
}

export async function getEntryByDate(date: string) {
  const [row] = await db
    .select({
      entry: journalEntries,
      currentVersion: journalVersions,
    })
    .from(journalEntries)
    .leftJoin(journalVersions, eq(journalEntries.currentVersionId, journalVersions.id))
    .where(and(eq(journalEntries.date, date), eq(journalEntries.status, "published")))
    .limit(1);
  return row ?? null;
}

export async function listEntries(opts: {
  from?: string;
  to?: string;
  limit: number;
  cursorDate?: string;
}) {
  const where = [eq(journalEntries.status, "published")];
  if (opts.cursorDate) where.push(lt(journalEntries.date, opts.cursorDate));
  if (opts.from) where.push(gte(journalEntries.date, opts.from));
  if (opts.to) where.push(lte(journalEntries.date, opts.to));
  return db
    .select({
      id: journalEntries.id,
      date: journalEntries.date,
      authorId: journalEntries.authorId,
      currentVersionId: journalEntries.currentVersionId,
      status: journalEntries.status,
      editCount: journalEntries.editCount,
      pendingSuggestionCount: journalEntries.pendingSuggestionCount,
      createdAt: journalEntries.createdAt,
      updatedAt: journalEntries.updatedAt,
      contentExcerpt: sql<string | null>`substring(${journalVersions.content} from 1 for ${EXCERPT_SOURCE_LEN})`,
    })
    .from(journalEntries)
    .leftJoin(journalVersions, eq(journalEntries.currentVersionId, journalVersions.id))
    .where(and(...where))
    .orderBy(desc(journalEntries.date))
    .limit(opts.limit);
}

export async function softDeleteEntry(date: string, authorId: string): Promise<boolean> {
  const result = await db
    .update(journalEntries)
    .set({ status: "trashed", updatedAt: new Date() })
    .where(and(eq(journalEntries.date, date), eq(journalEntries.authorId, authorId)))
    .returning({ id: journalEntries.id });
  return result.length > 0;
}
