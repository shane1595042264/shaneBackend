// src/modules/journal/comments-repo.ts
import { and, asc, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { journalComments, journalEntries } from "@/db/schema";

export async function createComment(input: {
  entryId: string;
  authorId: string;
  content: string;
  parentCommentId?: string | null;
}) {
  const [row] = await db
    .insert(journalComments)
    .values({
      entryId: input.entryId,
      authorId: input.authorId,
      content: input.content,
      parentCommentId: input.parentCommentId ?? null,
    })
    .returning();
  return row;
}

export async function listForEntry(entryId: string) {
  return db
    .select()
    .from(journalComments)
    .where(eq(journalComments.entryId, entryId))
    .orderBy(asc(journalComments.createdAt));
}

export async function getComment(id: string) {
  const [row] = await db
    .select()
    .from(journalComments)
    .where(eq(journalComments.id, id))
    .limit(1);
  return row ?? null;
}

export async function updateComment(commentId: string, authorId: string, content: string) {
  const [row] = await db
    .update(journalComments)
    .set({ content, editedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(journalComments.id, commentId), eq(journalComments.authorId, authorId)))
    .returning();
  return row ?? null;
}

export async function deleteComment(commentId: string, callerId: string): Promise<boolean> {
  // Either the comment author OR the entry author can delete.
  const [row] = await db
    .select({
      commentId: journalComments.id,
      commentAuthor: journalComments.authorId,
      entryAuthor: journalEntries.authorId,
    })
    .from(journalComments)
    .innerJoin(journalEntries, eq(journalEntries.id, journalComments.entryId))
    .where(eq(journalComments.id, commentId))
    .limit(1);
  if (!row) return false;
  if (row.commentAuthor !== callerId && row.entryAuthor !== callerId) return false;
  await db.delete(journalComments).where(eq(journalComments.id, commentId));
  return true;
}
