/**
 * Pure SRS transition math for vocab practice. No DB, no IO. Given a card's
 * current per-(word,location) state and a grade, compute the next level, due
 * date, and memorized flag. The repo applies the result. Mirrors strikes.ts.
 *
 * Levels: 0 (new/lapsed) .. levelToMemorize (memorized, graduates out of the
 * due pool). "Remember" climbs one level and schedules the next review further
 * out; "Forget" drops one level and reschedules soon. Reaching levelToMemorize
 * marks the word memorized at that location (justMemorized = true on the
 * crossing grade only).
 */
export type Grade = "remember" | "forget";

export interface VocabIntervals {
  intervalL1Days: number; // schedule after reaching level 1
  intervalL2Days: number; // schedule after reaching level 2
  lapseIntervalDays: number; // schedule after a forget
  levelToMemorize: number; // 1..3; reaching it = memorized
}

export interface SrsState {
  level: number;
  dueAt: Date | null;
  memorizedAt: Date | null;
}

export interface Transition {
  level: number;
  dueAt: Date | null;
  memorizedAt: Date | null;
  justMemorized: boolean;
}

function addDays(now: Date, days: number): Date {
  return new Date(now.getTime() + days * 86_400_000);
}

export function applyGrade(
  current: SrsState,
  grade: Grade,
  intervals: VocabIntervals,
  now: Date,
): Transition {
  const cap = intervals.levelToMemorize;

  if (grade === "forget") {
    return {
      level: Math.max(0, current.level - 1),
      dueAt: addDays(now, intervals.lapseIntervalDays),
      memorizedAt: null,
      justMemorized: false,
    };
  }

  // remember
  const level = Math.min(cap, current.level + 1);
  if (level >= cap) {
    return {
      level,
      dueAt: null,
      memorizedAt: now,
      justMemorized: current.level < cap,
    };
  }
  // Non-memorized branch: level can only be 1 or 2 (cap ≤ 3).
  const days = level >= 2 ? intervals.intervalL2Days : intervals.intervalL1Days;
  return { level, dueAt: addDays(now, days), memorizedAt: null, justMemorized: false };
}
