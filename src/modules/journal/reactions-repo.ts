// src/modules/journal/reactions-repo.ts
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { entryReactions, commentReactions } from "@/db/schema";

export const ALLOWED_EMOJI = [
  "+1",
  "-1",
  "laugh",
  "heart",
  "hooray",
  "rocket",
  "eyes",
  "confused",
] as const;
export type Emoji = typeof ALLOWED_EMOJI[number];

export function isAllowedEmoji(e: string): e is Emoji {
  return (ALLOWED_EMOJI as readonly string[]).includes(e);
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

// SHAN-591: a toggle is read-then-write, so two concurrent toggles of the same
// reaction both read "no row" under READ COMMITTED and the second insert hits
// the (user, target, emoji) unique key as an unhandled 500. Serializing on a
// transaction-scoped advisory lock keyed on that triple makes the waiter's
// select (a fresh snapshot per statement) see the first toggle's committed
// result, so two toggles add then remove, as two clicks should. The lock is
// released at commit or rollback; a hash collision only costs extra waiting.
export async function lockReaction(tx: Tx, key: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
}

// The routes check the target exists before toggling; one deleted in between
// fails the insert's foreign key. Callers map this to a 404.
export function isForeignKeyViolation(err: any): boolean {
  return err?.code === "23503" || err?.cause?.code === "23503";
}

export async function toggleEntryReaction(
  userId: string,
  entryId: string,
  emoji: Emoji
): Promise<"added" | "removed" | null> {
  return db.transaction(async (tx) => {
    await lockReaction(tx, `entry:${userId}:${entryId}:${emoji}`);
    const existing = await tx
      .select({ id: entryReactions.id })
      .from(entryReactions)
      .where(
        and(
          eq(entryReactions.userId, userId),
          eq(entryReactions.entryId, entryId),
          eq(entryReactions.emoji, emoji)
        )
      )
      .limit(1);
    if (existing.length > 0) {
      await tx.delete(entryReactions).where(eq(entryReactions.id, existing[0].id));
      return "removed";
    }
    await tx.insert(entryReactions).values({ userId, entryId, emoji });
    return "added" as const;
  }).catch((err) => {
    if (isForeignKeyViolation(err)) return null;
    throw err;
  });
}

export async function toggleCommentReaction(
  userId: string,
  commentId: string,
  emoji: Emoji
): Promise<"added" | "removed" | null> {
  return db.transaction(async (tx) => {
    await lockReaction(tx, `comment:${userId}:${commentId}:${emoji}`);
    const existing = await tx
      .select({ id: commentReactions.id })
      .from(commentReactions)
      .where(
        and(
          eq(commentReactions.userId, userId),
          eq(commentReactions.commentId, commentId),
          eq(commentReactions.emoji, emoji)
        )
      )
      .limit(1);
    if (existing.length > 0) {
      await tx.delete(commentReactions).where(eq(commentReactions.id, existing[0].id));
      return "removed";
    }
    await tx.insert(commentReactions).values({ userId, commentId, emoji });
    return "added" as const;
  }).catch((err) => {
    if (isForeignKeyViolation(err)) return null;
    throw err;
  });
}

export async function summarizeEntryReactions(entryId: string) {
  return db
    .select({
      emoji: entryReactions.emoji,
      count: sql<number>`count(*)::int`,
    })
    .from(entryReactions)
    .where(eq(entryReactions.entryId, entryId))
    .groupBy(entryReactions.emoji);
}

export async function summarizeCommentReactions(commentId: string) {
  return db
    .select({
      emoji: commentReactions.emoji,
      count: sql<number>`count(*)::int`,
    })
    .from(commentReactions)
    .where(eq(commentReactions.commentId, commentId))
    .groupBy(commentReactions.emoji);
}

export async function listMyReactionsForEntry(entryId: string, userId: string) {
  return db
    .select({ emoji: entryReactions.emoji })
    .from(entryReactions)
    .where(and(eq(entryReactions.entryId, entryId), eq(entryReactions.userId, userId)));
}

export async function listMyReactionsForComment(commentId: string, userId: string) {
  return db
    .select({ emoji: commentReactions.emoji })
    .from(commentReactions)
    .where(and(eq(commentReactions.commentId, commentId), eq(commentReactions.userId, userId)));
}
