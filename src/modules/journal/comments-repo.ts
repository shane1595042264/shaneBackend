// src/modules/journal/comments-repo.ts
import { and, asc, eq, getTableColumns, inArray, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { commentReactions, journalComments, journalEntries, users } from "@/db/schema";

/**
 * SHAN-577: what an inline note is pinned to. `target` is "entry" for the
 * entry body or the id of an append on the same entry. `quote` is the
 * selected text as rendered, whitespace collapsed; `prefix`/`suffix` are up
 * to 64 rendered characters either side, which is what picks the right one
 * when the quote occurs more than once. The client resolves it against the
 * rendered text; the server only stores it.
 */
export interface CommentAnchor {
  target: string;
  quote: string;
  prefix: string;
  suffix: string;
}

export async function createComment(input: {
  entryId: string;
  authorId: string;
  authorTimezone?: string;
  content: string;
  parentCommentId?: string | null;
  anchor?: CommentAnchor | null;
  /** SHAN-596: {kind: "ai", provider, model} on an Explain answer. */
  meta?: Record<string, unknown> | null;
}) {
  const [row] = await db
    .insert(journalComments)
    .values({
      entryId: input.entryId,
      authorId: input.authorId,
      authorTimezone: input.authorTimezone ?? "America/Chicago",
      content: input.content,
      parentCommentId: input.parentCommentId ?? null,
      anchor: input.anchor ?? null,
      meta: input.meta ?? null,
    })
    .returning();
  return row;
}

export async function listForEntry(entryId: string, viewerId?: string | null) {
  const rows = await db
    .select({
      ...getTableColumns(journalComments),
      authorName: users.name,
      authorAvatarUrl: users.avatarUrl,
    })
    .from(journalComments)
    .leftJoin(users, eq(users.id, journalComments.authorId))
    .where(eq(journalComments.entryId, entryId))
    .orderBy(asc(journalComments.createdAt));

  const comments = rows.map(({ authorName, authorAvatarUrl, ...comment }) => ({
    ...comment,
    author: comment.authorId
      ? { id: comment.authorId, name: authorName, avatarUrl: authorAvatarUrl }
      : null,
    reactions: { summary: [] as { emoji: string; count: number }[], mine: [] as string[] },
  }));

  if (comments.length === 0) return comments;

  const ids = comments.map((c) => c.id);
  // Batch-aggregate reactions for every comment on this entry so the page can render
  // chips without N round-trips to /comments/:id/reactions per comment.
  const summaryRows = await db
    .select({
      commentId: commentReactions.commentId,
      emoji: commentReactions.emoji,
      count: sql<number>`count(*)::int`,
    })
    .from(commentReactions)
    .where(inArray(commentReactions.commentId, ids))
    .groupBy(commentReactions.commentId, commentReactions.emoji);

  const summaryByComment = new Map<string, { emoji: string; count: number }[]>();
  for (const r of summaryRows) {
    const list = summaryByComment.get(r.commentId) ?? [];
    list.push({ emoji: r.emoji, count: r.count });
    summaryByComment.set(r.commentId, list);
  }

  let mineByComment: Map<string, string[]> | null = null;
  if (viewerId) {
    const mineRows = await db
      .select({
        commentId: commentReactions.commentId,
        emoji: commentReactions.emoji,
      })
      .from(commentReactions)
      .where(and(eq(commentReactions.userId, viewerId), inArray(commentReactions.commentId, ids)));
    mineByComment = new Map();
    for (const r of mineRows) {
      const list = mineByComment.get(r.commentId) ?? [];
      list.push(r.emoji);
      mineByComment.set(r.commentId, list);
    }
  }

  for (const c of comments) {
    c.reactions.summary = summaryByComment.get(c.id) ?? [];
    c.reactions.mine = mineByComment?.get(c.id) ?? [];
  }
  return comments;
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
      anchor: journalComments.anchor,
      parentCommentId: journalComments.parentCommentId,
    })
    .from(journalComments)
    .innerJoin(journalEntries, eq(journalEntries.id, journalComments.entryId))
    .where(eq(journalComments.id, commentId))
    .limit(1);
  if (!row) return false;
  if (row.commentAuthor !== callerId && row.entryAuthor !== callerId) return false;

  if (!row.anchor || row.parentCommentId) {
    await db.delete(journalComments).where(eq(journalComments.id, commentId));
    return true;
  }

  // SHAN-577: deleting the note that opened an inline thread. The FK would
  // promote every reply to an ordinary top-level comment (SHAN-574), which
  // tears the discussion off the words it is about and scatters it into the
  // general thread. Instead the earliest reply becomes the new root and
  // inherits the anchor, and the rest re-parent onto it, so the thread stays
  // pinned where it was. With no replies this is a plain delete.
  await db.transaction(async (tx) => {
    const replies = await tx
      .select({ id: journalComments.id })
      .from(journalComments)
      .where(eq(journalComments.parentCommentId, commentId))
      .orderBy(asc(journalComments.createdAt), asc(journalComments.id));
    const [heir, ...rest] = replies;
    if (heir) {
      await tx
        .update(journalComments)
        .set({ parentCommentId: null, anchor: row.anchor })
        .where(eq(journalComments.id, heir.id));
      if (rest.length > 0) {
        await tx
          .update(journalComments)
          .set({ parentCommentId: heir.id })
          .where(inArray(journalComments.id, rest.map((r) => r.id)));
      }
    }
    await tx.delete(journalComments).where(eq(journalComments.id, commentId));
  });
  return true;
}
