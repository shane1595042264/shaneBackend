import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { vocabWords, practicePrescriptions, practiceSessionItems, practiceSessions } from "@/db/schema";
import { computeProgress, type Thresholds } from "./strikes";
import { listItemRowsForProgress, listItemRowsForProgressByItems } from "./session-items-repo";
import { getSettings } from "./settings-repo";

export interface PracticeableItemSummary {
  itemId: string;
  word: string;
  category: string;
  source: unknown;
  prescription: { setMode: "time" | "reps"; setSize: number; restSeconds: number };
  totalStrikes: number;
  loadedLocations: number;
  isSolidified: boolean;
  lastPracticedAt: string | null;
}

/**
 * List all practice-able knowledge items (those with a prescription) joined
 * with the calling user's progress. Optional category filter + skip-solidified
 * toggle. Progress rows for all items are fetched in one batched query
 * (listItemRowsForProgressByItems), so the query count is constant regardless
 * of how many practice-able items the user has.
 */
export async function listPracticeableItems(opts: {
  userId: string;
  categoryFilter: string | null;
  includeSolidified: boolean;
}): Promise<PracticeableItemSummary[]> {
  const settings = await getSettings();
  const t: Thresholds = {
    setsPerStrike: settings.setsPerStrike,
    strikesPerLoadedLocation: settings.strikesPerLoadedLocation,
    locationsToSolidify: settings.locationsToSolidify,
  };

  const baseQuery = db
    .select({
      itemId: vocabWords.id,
      word: vocabWords.word,
      category: vocabWords.category,
      source: vocabWords.source,
      setMode: practicePrescriptions.setMode,
      setSize: practicePrescriptions.setSize,
      restSeconds: practicePrescriptions.restSeconds,
    })
    .from(vocabWords)
    .innerJoin(practicePrescriptions, eq(practicePrescriptions.itemId, vocabWords.id));

  const items = opts.categoryFilter
    ? await baseQuery.where(eq(vocabWords.category, opts.categoryFilter))
    : await baseQuery;

  const lastPracticedRows = await db
    .select({
      itemId: practiceSessionItems.itemId,
      lastCompletedAt: sql<Date | string | null>`max(${practiceSessionItems.completedAt})`,
    })
    .from(practiceSessionItems)
    .innerJoin(practiceSessions, eq(practiceSessions.id, practiceSessionItems.sessionId))
    .where(and(
      eq(practiceSessions.userId, opts.userId),
      isNotNull(practiceSessionItems.completedAt),
    ))
    .groupBy(practiceSessionItems.itemId);

  const lastPracticedMap = new Map<string, string>();
  for (const r of lastPracticedRows) {
    if (r.lastCompletedAt) {
      lastPracticedMap.set(
        r.itemId,
        r.lastCompletedAt instanceof Date ? r.lastCompletedAt.toISOString() : String(r.lastCompletedAt),
      );
    }
  }

  const progressByItem = await listItemRowsForProgressByItems(
    opts.userId,
    items.map((it) => it.itemId),
  );

  const summaries: PracticeableItemSummary[] = [];
  for (const it of items) {
    const rows = progressByItem.get(it.itemId) ?? [];
    const p = computeProgress(rows, t);
    const summary: PracticeableItemSummary = {
      itemId: it.itemId,
      word: it.word,
      category: it.category,
      source: it.source,
      prescription: {
        setMode: it.setMode as "time" | "reps",
        setSize: it.setSize,
        restSeconds: it.restSeconds,
      },
      totalStrikes: p.totalStrikes,
      loadedLocations: p.loadedLocations.length,
      isSolidified: p.isSolidified,
      lastPracticedAt: lastPracticedMap.get(it.itemId) ?? null,
    };
    if (opts.includeSolidified || !summary.isSolidified) summaries.push(summary);
  }
  // Sort coldest-first so the index doubles as a triage list: never-practiced
  // items (strongest "pick me next" signal) go to the top, then longest-cold,
  // then most-recently-practiced. Word ASC tiebreaker keeps the order stable.
  summaries.sort((a, b) => {
    if (a.lastPracticedAt === null && b.lastPracticedAt === null) {
      return a.word.localeCompare(b.word);
    }
    if (a.lastPracticedAt === null) return -1;
    if (b.lastPracticedAt === null) return 1;
    if (a.lastPracticedAt < b.lastPracticedAt) return -1;
    if (a.lastPracticedAt > b.lastPracticedAt) return 1;
    return a.word.localeCompare(b.word);
  });
  return summaries;
}

export interface ItemProgressDetail {
  itemId: string;
  word: string;
  prescription: { setMode: "time" | "reps"; setSize: number; restSeconds: number };
  totalStrikes: number;
  isSolidified: boolean;
  loadedLocationCount: number;
  lastPracticedAt: string | null;
  strikesByLocation: Array<{
    locationId: string | null;
    locationName: string | null;
    strikeCount: number;
    isLoaded: boolean;
  }>;
}

export async function getItemProgressDetail(
  userId: string,
  itemId: string,
): Promise<ItemProgressDetail | null> {
  const [item] = await db
    .select({
      itemId: vocabWords.id,
      word: vocabWords.word,
      setMode: practicePrescriptions.setMode,
      setSize: practicePrescriptions.setSize,
      restSeconds: practicePrescriptions.restSeconds,
    })
    .from(vocabWords)
    .innerJoin(practicePrescriptions, eq(practicePrescriptions.itemId, vocabWords.id))
    .where(eq(vocabWords.id, itemId))
    .limit(1);
  if (!item) return null;

  const settings = await getSettings();
  const t: Thresholds = {
    setsPerStrike: settings.setsPerStrike,
    strikesPerLoadedLocation: settings.strikesPerLoadedLocation,
    locationsToSolidify: settings.locationsToSolidify,
  };

  const rows = await listItemRowsForProgress(userId, itemId);
  const p = computeProgress(rows, t);

  const locNames = new Map<string, string>();
  const namedRows = await db
    .select({
      locationId: practiceSessionItems.locationId,
      locationName: practiceSessionItems.locationName,
    })
    .from(practiceSessionItems)
    .innerJoin(practiceSessions, eq(practiceSessions.id, practiceSessionItems.sessionId))
    .where(and(eq(practiceSessions.userId, userId), eq(practiceSessionItems.itemId, itemId)));
  for (const r of namedRows) {
    if (r.locationId && r.locationName) locNames.set(r.locationId, r.locationName);
  }

  const strikesByLocation = [...p.strikeCountsByLocation.entries()].map(([locId, count]) => ({
    locationId: locId,
    locationName: locNames.get(locId) ?? null,
    strikeCount: count,
    isLoaded: count >= t.strikesPerLoadedLocation,
  }));

  const [latest] = await db
    .select({ completedAt: practiceSessionItems.completedAt })
    .from(practiceSessionItems)
    .innerJoin(practiceSessions, eq(practiceSessions.id, practiceSessionItems.sessionId))
    .where(and(
      eq(practiceSessions.userId, userId),
      eq(practiceSessionItems.itemId, itemId),
      isNotNull(practiceSessionItems.completedAt),
    ))
    .orderBy(desc(practiceSessionItems.completedAt))
    .limit(1);
  const lastPracticedAt = latest?.completedAt
    ? (latest.completedAt instanceof Date ? latest.completedAt.toISOString() : String(latest.completedAt))
    : null;

  return {
    itemId: item.itemId,
    word: item.word,
    prescription: {
      setMode: item.setMode as "time" | "reps",
      setSize: item.setSize,
      restSeconds: item.restSeconds,
    },
    totalStrikes: p.totalStrikes,
    isSolidified: p.isSolidified,
    loadedLocationCount: p.loadedLocations.length,
    lastPracticedAt,
    strikesByLocation,
  };
}
