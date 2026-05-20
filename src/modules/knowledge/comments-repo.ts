// src/modules/knowledge/comments-repo.ts
import { and, asc, eq, getTableColumns } from "drizzle-orm";
import { db } from "@/db/client";
import { knowledgeComments, users, vocabWords } from "@/db/schema";

export async function createComment(input: {
  entryId: string;
  authorId: string;
  content: string;
  parentCommentId?: string | null;
}) {
  const [row] = await db
    .insert(knowledgeComments)
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
  const rows = await db
    .select({
      ...getTableColumns(knowledgeComments),
      authorName: users.name,
      authorAvatarUrl: users.avatarUrl,
    })
    .from(knowledgeComments)
    .leftJoin(users, eq(users.id, knowledgeComments.authorId))
    .where(eq(knowledgeComments.entryId, entryId))
    .orderBy(asc(knowledgeComments.createdAt));

  return rows.map(({ authorName, authorAvatarUrl, ...comment }) => ({
    ...comment,
    author: comment.authorId
      ? { id: comment.authorId, name: authorName, avatarUrl: authorAvatarUrl }
      : null,
  }));
}

export async function getComment(id: string) {
  const [row] = await db
    .select()
    .from(knowledgeComments)
    .where(eq(knowledgeComments.id, id))
    .limit(1);
  return row ?? null;
}

export async function updateComment(commentId: string, authorId: string, content: string) {
  const [row] = await db
    .update(knowledgeComments)
    .set({ content, editedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(knowledgeComments.id, commentId), eq(knowledgeComments.authorId, authorId)))
    .returning();
  return row ?? null;
}

// Comment author OR entry creator can delete. Legacy entries (vocab_words.created_by IS NULL,
// predate the column) grant no extra power — only the comment author can delete on those.
export async function deleteComment(commentId: string, callerId: string): Promise<boolean> {
  const [row] = await db
    .select({
      commentId: knowledgeComments.id,
      commentAuthor: knowledgeComments.authorId,
      entryAuthor: vocabWords.createdBy,
    })
    .from(knowledgeComments)
    .innerJoin(vocabWords, eq(vocabWords.id, knowledgeComments.entryId))
    .where(eq(knowledgeComments.id, commentId))
    .limit(1);
  if (!row) return false;
  if (row.commentAuthor !== callerId && row.entryAuthor !== callerId) return false;
  await db.delete(knowledgeComments).where(eq(knowledgeComments.id, commentId));
  return true;
}
