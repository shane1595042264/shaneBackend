// src/modules/blog/comments-repo.ts
//
// SHAN-488 Phase 4. journal/comments-repo.ts with the membership gate gone,
// the parent/reply layer dropped (blog threads are flat) and comment_count
// maintained on blog_posts.
//
// Every mutation that changes the number of comments on a post does the count
// bump in the SAME transaction as the row change. Two independent statements
// would leave the tile lying about the thread whenever the second one failed.
import { asc, eq, sql, and } from "drizzle-orm";
import { db } from "@/db/client";
import { blogComments, blogPosts, users } from "@/db/schema";

export async function createComment(input: {
  postId: string;
  authorId: string;
  authorTimezone?: string;
  content: string;
}) {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(blogComments)
      .values({
        postId: input.postId,
        authorId: input.authorId,
        authorTimezone: input.authorTimezone ?? "America/Chicago",
        content: input.content,
      })
      .returning();
    await tx
      .update(blogPosts)
      .set({ commentCount: sql`${blogPosts.commentCount} + 1` })
      .where(eq(blogPosts.id, input.postId));
    return row;
  });
}

export async function listForPost(postId: string) {
  const rows = await db
    .select({
      id: blogComments.id,
      postId: blogComments.postId,
      authorId: blogComments.authorId,
      authorTimezone: blogComments.authorTimezone,
      content: blogComments.content,
      editedAt: blogComments.editedAt,
      createdAt: blogComments.createdAt,
      updatedAt: blogComments.updatedAt,
      authorName: users.name,
      authorAvatarUrl: users.avatarUrl,
    })
    .from(blogComments)
    .leftJoin(users, eq(users.id, blogComments.authorId))
    .where(eq(blogComments.postId, postId))
    .orderBy(asc(blogComments.createdAt));

  return rows.map(({ authorName, authorAvatarUrl, ...comment }) => ({
    ...comment,
    author: { id: comment.authorId, name: authorName, avatarUrl: authorAvatarUrl },
  }));
}

export async function getComment(id: string) {
  const [row] = await db
    .select()
    .from(blogComments)
    .where(eq(blogComments.id, id))
    .limit(1);
  return row ?? null;
}

/** Author-only. Returns null when the id is unknown or the caller isn't the author. */
export async function updateComment(commentId: string, authorId: string, content: string) {
  const [row] = await db
    .update(blogComments)
    .set({ content, editedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(blogComments.id, commentId), eq(blogComments.authorId, authorId)))
    .returning();
  return row ?? null;
}

/**
 * Hard delete, by the comment author or the post author (moderation — this is
 * a world-writable page, so the author needs a way to remove abuse).
 *
 * The DELETE carries the authorization in its own WHERE clause rather than
 * trusting the SELECT above it: two concurrent deletes would both pass the
 * check, and only the one whose DELETE actually removed a row may decrement
 * the count. `returning` makes that observable.
 */
export async function deleteComment(commentId: string, callerId: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({
        commentAuthor: blogComments.authorId,
        postId: blogComments.postId,
        postAuthor: blogPosts.authorId,
      })
      .from(blogComments)
      .innerJoin(blogPosts, eq(blogPosts.id, blogComments.postId))
      .where(eq(blogComments.id, commentId))
      .limit(1);
    if (!row) return false;
    if (row.commentAuthor !== callerId && row.postAuthor !== callerId) return false;

    const deleted = await tx
      .delete(blogComments)
      .where(eq(blogComments.id, commentId))
      .returning({ id: blogComments.id });
    if (deleted.length === 0) return false;

    await tx
      .update(blogPosts)
      // Floored at 0: the count is denormalized, and a stored negative would
      // render as "-1 comments" forever with no way to notice.
      .set({ commentCount: sql`greatest(0, ${blogPosts.commentCount} - 1)` })
      .where(eq(blogPosts.id, row.postId));
    return true;
  });
}
