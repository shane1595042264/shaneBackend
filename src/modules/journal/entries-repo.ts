import { createHash } from "node:crypto";
import { and, eq, desc, lt, gte, lte, or, ilike, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { journalEntries, journalVersions, journalComments, journalAppends, users } from "@/db/schema";

const EXCERPT_SOURCE_LEN = 500;
// When a content search (q) matches deep in the body, start the excerpt this many
// chars before the first match so the matched term is visible in the result card.
const SNIPPET_CONTEXT_BEFORE = 60;

export function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export async function createEntry(input: {
  date: string;
  authorId: string;
  /** IANA timezone snapshot. Falls back to America/Chicago if omitted (test convenience). */
  authorTimezone?: string;
  content: string;
}): Promise<{ entry: typeof journalEntries.$inferSelect; version: typeof journalVersions.$inferSelect }> {
  return db.transaction(async (tx) => {
    const [entry] = await tx
      .insert(journalEntries)
      .values({
        date: input.date,
        authorId: input.authorId,
        authorTimezone: input.authorTimezone ?? "America/Chicago",
      })
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
      authorName: users.name,
      authorAvatarUrl: users.avatarUrl,
    })
    .from(journalEntries)
    .leftJoin(journalVersions, eq(journalEntries.currentVersionId, journalVersions.id))
    .leftJoin(users, eq(users.id, journalEntries.authorId))
    .where(and(eq(journalEntries.date, date), eq(journalEntries.status, "published")))
    .limit(1);
  if (!row) return null;
  const { authorName, authorAvatarUrl, ...rest } = row;
  return {
    ...rest,
    author: { id: rest.entry.authorId, name: authorName, avatarUrl: authorAvatarUrl },
  };
}

export async function listEntries(opts: {
  from?: string;
  to?: string;
  /** Case-insensitive content search across the current version body and any appends. */
  q?: string;
  limit: number;
  cursorDate?: string;
}) {
  const where = [eq(journalEntries.status, "published")];
  if (opts.cursorDate) where.push(lt(journalEntries.date, opts.cursorDate));
  if (opts.from) where.push(gte(journalEntries.date, opts.from));
  if (opts.to) where.push(lte(journalEntries.date, opts.to));
  if (opts.q) {
    // Escape LIKE wildcards so a literal % or _ in the query doesn't act as a pattern.
    const pattern = `%${opts.q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
    where.push(
      or(
        ilike(journalVersions.content, pattern),
        sql`EXISTS (SELECT 1 FROM ${journalAppends} WHERE ${journalAppends.entryId} = ${journalEntries.id} AND ${journalAppends.content} ILIKE ${pattern})`
      )!
    );
  }
  // Combined searchable text: current version body followed by all appends, in order.
  const sourceText = sql`${journalVersions.content} || coalesce(
        (SELECT E'\n\n' || string_agg(${journalAppends.content}, E'\n\n' ORDER BY ${journalAppends.createdAt} ASC)
           FROM ${journalAppends}
           WHERE ${journalAppends.entryId} = ${journalEntries.id}),
        ''
      )`;
  // When searching, start the excerpt a small window before the first case-insensitive
  // match so the matched term is visible in the result card; otherwise start at the top.
  const excerptStart = opts.q
    ? sql`greatest(1, position(lower(${opts.q}) in lower(${sourceText})) - ${SNIPPET_CONTEXT_BEFORE})`
    : sql`1`;
  // When the excerpt is trimmed at the front (search match sits deep in the body,
  // so excerptStart > 1) prepend a leading ellipsis so the snippet reads as a
  // fragment instead of starting abruptly mid-word. Non-search listings start at
  // position 1, so this is constant-false there. The trailing ellipsis is handled
  // client-side by toPlainExcerpt when it re-truncates the end.
  const leadingEllipsis = sql`case when ${excerptStart} > 1 then '…' else '' end`;
  const rows = await db
    .select({
      id: journalEntries.id,
      date: journalEntries.date,
      authorId: journalEntries.authorId,
      authorTimezone: journalEntries.authorTimezone,
      currentVersionId: journalEntries.currentVersionId,
      status: journalEntries.status,
      editCount: journalEntries.editCount,
      pendingSuggestionCount: journalEntries.pendingSuggestionCount,
      createdAt: journalEntries.createdAt,
      updatedAt: journalEntries.updatedAt,
      contentExcerpt: sql<string | null>`${leadingEllipsis} || substring(${sourceText} from ${excerptStart} for ${EXCERPT_SOURCE_LEN})`,
      commentCount: sql<number>`(SELECT COUNT(*)::int FROM ${journalComments} WHERE ${journalComments.entryId} = ${journalEntries.id})`,
      appendCount: sql<number>`(SELECT COUNT(*)::int FROM ${journalAppends} WHERE ${journalAppends.entryId} = ${journalEntries.id})`,
      authorName: users.name,
      authorAvatarUrl: users.avatarUrl,
    })
    .from(journalEntries)
    .leftJoin(journalVersions, eq(journalEntries.currentVersionId, journalVersions.id))
    .leftJoin(users, eq(users.id, journalEntries.authorId))
    .where(and(...where))
    .orderBy(desc(journalEntries.date))
    .limit(opts.limit);
  return rows.map(({ authorName, authorAvatarUrl, ...rest }) => ({
    ...rest,
    author: { id: rest.authorId, name: authorName, avatarUrl: authorAvatarUrl },
  }));
}

export async function softDeleteEntry(date: string, authorId: string): Promise<boolean> {
  const result = await db
    .update(journalEntries)
    .set({ status: "trashed", updatedAt: new Date() })
    .where(and(eq(journalEntries.date, date), eq(journalEntries.authorId, authorId)))
    .returning({ id: journalEntries.id });
  return result.length > 0;
}
