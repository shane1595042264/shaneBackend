import { and, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { vocabSrs, vocabReviews, vocabWords } from "@/db/schema";
import { getSettings } from "./settings-repo";
import { applyGrade, type SrsState } from "./vocab-srs";
import { applyLocationDelta, computeLongTermMemorized } from "@/modules/knowledge/memorization";

export interface ApplyReviewInput {
  userId: string;
  sessionId: string;
  itemId: string;
  locationId: string | null;
  locationName: string;
  locationNormalized: string;
  grade: "remember" | "forget";
  now?: Date; // injectable for tests; defaults to new Date()
}

export interface ApplyReviewResult {
  level: number;
  dueAt: Date | null;
  memorized: boolean;
  longTermMemorized: boolean;
}

/**
 * Apply one grade to the (user, item, location) SRS row: upsert the state via
 * the pure transition, append the append-only review log, and — on crossing
 * into "memorized" (level = levelToMemorize) — feed SHAN-339 by adding the
 * location to the shared card's memorization_locations and recomputing
 * long_term_memorized. See docs/superpowers/specs/2026-07-24-vocab-practice-mode-design.md.
 */
export async function applyReview(input: ApplyReviewInput): Promise<ApplyReviewResult> {
  const now = input.now ?? new Date();
  const s = await getSettings();
  const intervals = {
    intervalL1Days: s.vocabIntervalL1Days,
    intervalL2Days: s.vocabIntervalL2Days,
    lapseIntervalDays: s.vocabLapseIntervalDays,
    levelToMemorize: s.vocabLevelToMemorize,
  };

  // 1. Current state for (user, item, location).
  const [existing] = await db
    .select()
    .from(vocabSrs)
    .where(
      and(
        eq(vocabSrs.userId, input.userId),
        eq(vocabSrs.itemId, input.itemId),
        eq(vocabSrs.locationNormalized, input.locationNormalized),
      ),
    )
    .limit(1);

  const current: SrsState = existing
    ? { level: existing.level, dueAt: existing.dueAt, memorizedAt: existing.memorizedAt }
    : { level: 0, dueAt: null, memorizedAt: null };

  const t = applyGrade(current, input.grade, intervals, now);
  const prevReps = existing?.reps ?? 0;
  const prevLapses = existing?.lapses ?? 0;
  const reps = prevReps + 1;
  const lapses = prevLapses + (input.grade === "forget" ? 1 : 0);

  // 2. Upsert the SRS row.
  await db
    .insert(vocabSrs)
    .values({
      userId: input.userId,
      itemId: input.itemId,
      locationId: input.locationId,
      locationName: input.locationName,
      locationNormalized: input.locationNormalized,
      level: t.level,
      dueAt: t.dueAt,
      memorizedAt: t.memorizedAt,
      lastReviewedAt: now,
      reps,
      lapses,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [vocabSrs.userId, vocabSrs.itemId, vocabSrs.locationNormalized],
      set: {
        locationId: input.locationId,
        locationName: input.locationName,
        level: t.level,
        dueAt: t.dueAt,
        memorizedAt: t.memorizedAt,
        lastReviewedAt: now,
        reps,
        lapses,
        updatedAt: now,
      },
    });

  // 3. Append the grade log.
  await db.insert(vocabReviews).values({
    sessionId: input.sessionId,
    userId: input.userId,
    itemId: input.itemId,
    grade: input.grade,
    levelBefore: current.level,
    levelAfter: t.level,
    reviewedAt: now,
  });

  // 4. On crossing into memorized, feed SHAN-339 on the shared card.
  let longTermMemorized = false;
  //    SHAN-556: read and write under a row lock. Without it, a concurrent edit
  //    of the card's locations (the knowledge panel, or another review) could
  //    land between the read and the write and one of the two would be lost.
  if (t.justMemorized) {
    longTermMemorized = await db.transaction(async (tx) => {
      const [card] = await tx
        .select({ locations: vocabWords.memorizationLocations })
        .from(vocabWords)
        .where(eq(vocabWords.id, input.itemId))
        .limit(1)
        .for("update");
      const locations = applyLocationDelta(card?.locations, [input.locationName]);
      const longTerm = computeLongTermMemorized(locations);
      await tx
        .update(vocabWords)
        .set({ memorizationLocations: locations, longTermMemorized: longTerm, updatedAt: now })
        .where(eq(vocabWords.id, input.itemId));
      return longTerm;
    });
  }

  return {
    level: t.level,
    dueAt: t.dueAt,
    memorized: t.memorizedAt !== null,
    longTermMemorized,
  };
}
