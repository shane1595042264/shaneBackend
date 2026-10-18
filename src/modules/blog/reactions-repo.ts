// src/modules/blog/reactions-repo.ts
//
// SHAN-488 Phase 4. Post-level reactions on the public blog.
//
// The emoji vocabulary is shared with the journal (the reaction_emoji pgEnum
// and journal/reactions-repo's ALLOWED_EMOJI) so a reaction means the same
// thing everywhere on the site; only the table differs.
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { blogPostReactions } from "@/db/schema";
import {
  isForeignKeyViolation,
  lockReaction,
  type Emoji,
} from "@/modules/journal/reactions-repo";

// SHAN-591: serialized like the journal toggles (see lockReaction); null means
// the post was deleted between the route's lookup and the insert.
export async function togglePostReaction(
  userId: string,
  postId: string,
  emoji: Emoji
): Promise<"added" | "removed" | null> {
  return db.transaction(async (tx) => {
    await lockReaction(tx, `post:${userId}:${postId}:${emoji}`);
    const existing = await tx
      .select({ id: blogPostReactions.id })
      .from(blogPostReactions)
      .where(
        and(
          eq(blogPostReactions.userId, userId),
          eq(blogPostReactions.postId, postId),
          eq(blogPostReactions.emoji, emoji)
        )
      )
      .limit(1);
    if (existing.length > 0) {
      await tx.delete(blogPostReactions).where(eq(blogPostReactions.id, existing[0].id));
      return "removed";
    }
    await tx.insert(blogPostReactions).values({ userId, postId, emoji });
    return "added" as const;
  }).catch((err) => {
    if (isForeignKeyViolation(err)) return null;
    throw err;
  });
}

export async function summarizePostReactions(postId: string) {
  return db
    .select({
      emoji: blogPostReactions.emoji,
      count: sql<number>`count(*)::int`,
    })
    .from(blogPostReactions)
    .where(eq(blogPostReactions.postId, postId))
    .groupBy(blogPostReactions.emoji);
}

export async function listMyReactionsForPost(postId: string, userId: string) {
  return db
    .select({ emoji: blogPostReactions.emoji })
    .from(blogPostReactions)
    .where(
      and(eq(blogPostReactions.postId, postId), eq(blogPostReactions.userId, userId))
    );
}
