import { and, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { vocabWords, practicePrescriptions, practiceSessionItems, practiceSessions } from "@/db/schema";
import { computeProgress, type Thresholds } from "./strikes";
import { listItemRowsForProgress } from "./session-items-repo";
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
}

/**
 * List all practice-able knowledge items (those with a prescription) joined
 * with the calling user's progress. Optional category filter + skip-solidified
 * toggle. N+1 by design — bounded by number of practice-able items (dozens).
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

  const summaries: PracticeableItemSummary[] = [];
  for (const it of items) {
    const rows = await listItemRowsForProgress(opts.userId, it.itemId);
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
    };
    if (opts.includeSolidified || !summary.isSolidified) summaries.push(summary);
  }
  return summaries;
}

export interface ItemProgressDetail {
  itemId: string;
  word: string;
  prescription: { setMode: "time" | "reps"; setSize: number; restSeconds: number };
  totalStrikes: number;
  isSolidified: boolean;
  loadedLocationCount: number;
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
    strikesByLocation,
  };
}
