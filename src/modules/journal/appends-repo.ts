import { and, asc, eq, isNull } from "drizzle-orm";
import { db } from "@/db/client";
import { journalAppends, users } from "@/db/schema";

export async function createAppend(input: {
  entryId: string;
  authorId: string;
  authorTimezone?: string;
  content: string;
}) {
  const [row] = await db
    .insert(journalAppends)
    .values({
      entryId: input.entryId,
      authorId: input.authorId,
      authorTimezone: input.authorTimezone ?? "America/Chicago",
      content: input.content,
    })
    .returning();
  return row;
}

export async function getAppend(id: string) {
  const [row] = await db
    .select()
    .from(journalAppends)
    .where(eq(journalAppends.id, id))
    .limit(1);
  return row ?? null;
}

/**
 * Edit an append in place (SHAN-483).
 *
 * Scoped by entryId as well as author so a caller can't reach an append on
 * some other entry by guessing its id through a URL whose :date they do own.
 * Soft-deleted rows are excluded — a deleted append is not editable back to
 * life, that would make the audit trail lie about what readers saw.
 */
export async function updateAppend(input: {
  id: string;
  entryId: string;
  authorId: string;
  content: string;
}) {
  const [row] = await db
    .update(journalAppends)
    .set({ content: input.content, editedAt: new Date() })
    .where(
      and(
        eq(journalAppends.id, input.id),
        eq(journalAppends.entryId, input.entryId),
        eq(journalAppends.authorId, input.authorId),
        isNull(journalAppends.deletedAt)
      )
    )
    .returning();
  return row ?? null;
}

/**
 * Soft-delete an append (SHAN-483) — this is the fix for "an agent added
 * double content and there is no way to delete the redundant part".
 *
 * Soft rather than hard so a mistaken removal is recoverable and the
 * journal_activity row still points at a row that exists. Already-deleted
 * rows return null so a repeat DELETE is a 404 rather than silently
 * rewriting deletedAt and logging a second audit event.
 */
export async function softDeleteAppend(input: {
  id: string;
  entryId: string;
  authorId: string;
}) {
  const [row] = await db
    .update(journalAppends)
    .set({ deletedAt: new Date() })
    .where(
      and(
        eq(journalAppends.id, input.id),
        eq(journalAppends.entryId, input.entryId),
        eq(journalAppends.authorId, input.authorId),
        isNull(journalAppends.deletedAt)
      )
    )
    .returning();
  return row ?? null;
}

export async function listAppendsForEntry(entryId: string) {
  const rows = await db
    .select({
      id: journalAppends.id,
      entryId: journalAppends.entryId,
      authorId: journalAppends.authorId,
      authorTimezone: journalAppends.authorTimezone,
      content: journalAppends.content,
      editedAt: journalAppends.editedAt,
      createdAt: journalAppends.createdAt,
      authorName: users.name,
      authorAvatarUrl: users.avatarUrl,
    })
    .from(journalAppends)
    .leftJoin(users, eq(users.id, journalAppends.authorId))
    // Soft-deleted appends stay in the table for recovery and audit but must
    // never render on the entry — that is the whole point of the delete.
    .where(and(eq(journalAppends.entryId, entryId), isNull(journalAppends.deletedAt)))
    .orderBy(asc(journalAppends.createdAt));

  return rows.map(({ authorName, authorAvatarUrl, ...rest }) => ({
    ...rest,
    author: { id: rest.authorId, name: authorName, avatarUrl: authorAvatarUrl },
  }));
}
