import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { practiceSessions, practiceSessionItems } from "@/db/schema";

export interface Session {
  id: string;
  userId: string;
  startedAt: Date;
  completedAt: Date | null;
  categoryFilter: string | null;
  nItemsRequested: number;
  createdAt: Date;
}

/** Used internally by the route layer to bundle picked items with session insert. */
export interface PickedItem {
  itemId: string;
}

export async function createSession(input: {
  userId: string;
  categoryFilter: string | null;
  nItemsRequested: number;
  items: PickedItem[];
}): Promise<{ session: Session; itemIds: string[] }> {
  return db.transaction(async (tx) => {
    const [session] = await tx
      .insert(practiceSessions)
      .values({
        userId: input.userId,
        categoryFilter: input.categoryFilter,
        nItemsRequested: input.nItemsRequested,
      })
      .returning();

    const itemRows = input.items.map((it, i) => ({
      sessionId: session.id,
      itemId: it.itemId,
      position: i,
    }));

    const inserted = await tx
      .insert(practiceSessionItems)
      .values(itemRows)
      .returning({ id: practiceSessionItems.id });

    return { session: session as Session, itemIds: inserted.map((r) => r.id) };
  });
}

export async function getSessionById(id: string, userId: string): Promise<Session | null> {
  const [row] = await db
    .select()
    .from(practiceSessions)
    .where(and(eq(practiceSessions.id, id), eq(practiceSessions.userId, userId)))
    .limit(1);
  return (row as Session | undefined) ?? null;
}

export async function listSessions(userId: string, limit = 50): Promise<Session[]> {
  return (await db
    .select()
    .from(practiceSessions)
    .where(eq(practiceSessions.userId, userId))
    .orderBy(desc(practiceSessions.startedAt))
    .limit(limit)) as Session[];
}

export async function markSessionCompleted(id: string, userId: string): Promise<boolean> {
  const out = await db
    .update(practiceSessions)
    .set({ completedAt: new Date() })
    .where(and(eq(practiceSessions.id, id), eq(practiceSessions.userId, userId)))
    .returning({ id: practiceSessions.id });
  return out.length > 0;
}

export async function deleteSession(id: string, userId: string): Promise<boolean> {
  const out = await db
    .delete(practiceSessions)
    .where(and(eq(practiceSessions.id, id), eq(practiceSessions.userId, userId)))
    .returning({ id: practiceSessions.id });
  return out.length > 0;
}
