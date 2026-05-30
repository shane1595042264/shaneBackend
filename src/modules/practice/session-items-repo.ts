import { and, asc, eq, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { practiceSessionItems, practiceSessions, vocabWords, practicePrescriptions } from "@/db/schema";
import type { SessionItemRow } from "./strikes";

export interface SessionItem {
  id: string;
  sessionId: string;
  itemId: string;
  position: number;
  locationId: string | null;
  locationName: string | null;
  setsCompleted: number;
  timerState: unknown;
  startedAt: Date | null;
  completedAt: Date | null;
  word: string;
  source: unknown;
  prescription: { setMode: "time" | "reps"; setSize: number; restSeconds: number } | null;
}

/**
 * Ordered list of items in a session, each enriched with the knowledge
 * item's word/source and its prescription via JOINs. This is what the
 * runner consumes directly — there is no separate per-item knowledge
 * fetch. prescription is null only if the item's prescription was deleted
 * after the session was created (the runner falls back to defaults).
 */
export async function listItemsForSession(sessionId: string): Promise<SessionItem[]> {
  const rows = await db
    .select({
      id: practiceSessionItems.id,
      sessionId: practiceSessionItems.sessionId,
      itemId: practiceSessionItems.itemId,
      position: practiceSessionItems.position,
      locationId: practiceSessionItems.locationId,
      locationName: practiceSessionItems.locationName,
      setsCompleted: practiceSessionItems.setsCompleted,
      timerState: practiceSessionItems.timerState,
      startedAt: practiceSessionItems.startedAt,
      completedAt: practiceSessionItems.completedAt,
      word: vocabWords.word,
      source: vocabWords.source,
      setMode: practicePrescriptions.setMode,
      setSize: practicePrescriptions.setSize,
      restSeconds: practicePrescriptions.restSeconds,
    })
    .from(practiceSessionItems)
    .innerJoin(vocabWords, eq(vocabWords.id, practiceSessionItems.itemId))
    .leftJoin(practicePrescriptions, eq(practicePrescriptions.itemId, practiceSessionItems.itemId))
    .where(eq(practiceSessionItems.sessionId, sessionId))
    .orderBy(asc(practiceSessionItems.position));

  return rows.map((r) => ({
    id: r.id,
    sessionId: r.sessionId,
    itemId: r.itemId,
    position: r.position,
    locationId: r.locationId,
    locationName: r.locationName,
    setsCompleted: r.setsCompleted,
    timerState: r.timerState,
    startedAt: r.startedAt,
    completedAt: r.completedAt,
    word: r.word ?? "(unknown)",
    source: r.source ?? null,
    prescription:
      r.setMode != null
        ? { setMode: r.setMode as "time" | "reps", setSize: r.setSize!, restSeconds: r.restSeconds! }
        : null,
  }));
}

/**
 * Sync endpoint backing function. Accepts any subset of mutable fields.
 * Verifies ownership via the parent session (so other users can't sync our items).
 */
export interface SyncInput {
  timerState?: unknown;
  setsCompleted?: number;
  locationId?: string | null;
  locationName?: string | null;
  completedAt?: Date | null;
  startedAt?: Date | null;
}

export async function syncSessionItem(
  itemRowId: string,
  userId: string,
  patch: SyncInput,
): Promise<SessionItem | null> {
  const [owned] = await db
    .select({ id: practiceSessionItems.id })
    .from(practiceSessionItems)
    .innerJoin(practiceSessions, eq(practiceSessions.id, practiceSessionItems.sessionId))
    .where(and(eq(practiceSessionItems.id, itemRowId), eq(practiceSessions.userId, userId)))
    .limit(1);
  if (!owned) return null;

  const set: Record<string, unknown> = {};
  if (patch.timerState !== undefined) set.timerState = patch.timerState;
  if (patch.setsCompleted !== undefined) set.setsCompleted = patch.setsCompleted;
  if (patch.locationId !== undefined) set.locationId = patch.locationId;
  if (patch.locationName !== undefined) set.locationName = patch.locationName;
  if (patch.completedAt !== undefined) set.completedAt = patch.completedAt;
  if (patch.startedAt !== undefined) set.startedAt = patch.startedAt;

  if (Object.keys(set).length > 0) {
    await db
      .update(practiceSessionItems)
      .set(set)
      .where(eq(practiceSessionItems.id, itemRowId));
  }

  // Re-read via the enriched list so the response shape is consistent.
  const [row] = (await db
    .select()
    .from(practiceSessionItems)
    .where(eq(practiceSessionItems.id, itemRowId))
    .limit(1)) as any[];
  if (!row) return null;
  return {
    id: row.id,
    sessionId: row.sessionId,
    itemId: row.itemId,
    position: row.position,
    locationId: row.locationId,
    locationName: row.locationName,
    setsCompleted: row.setsCompleted,
    timerState: row.timerState,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    word: "",
    source: null,
    prescription: null,
  };
}

/**
 * All session_item rows for one (user, item) — feeds into strikes.computeProgress.
 * Excludes rows with sets_completed=0 for efficiency.
 */
export async function listItemRowsForProgress(
  userId: string,
  itemId: string,
): Promise<SessionItemRow[]> {
  const rows = await db
    .select({
      itemId: practiceSessionItems.itemId,
      locationId: practiceSessionItems.locationId,
      setsCompleted: practiceSessionItems.setsCompleted,
      completedAt: practiceSessionItems.completedAt,
    })
    .from(practiceSessionItems)
    .innerJoin(practiceSessions, eq(practiceSessions.id, practiceSessionItems.sessionId))
    .where(
      and(
        eq(practiceSessions.userId, userId),
        eq(practiceSessionItems.itemId, itemId),
        sql`${practiceSessionItems.setsCompleted} > 0`,
      ),
    );
  return rows as SessionItemRow[];
}
