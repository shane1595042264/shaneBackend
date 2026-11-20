// src/modules/courses/recall.ts
//
// SHAN-722: the spaced recall check on a certificate course. Finishing the
// lessons proves the learner knew the material while it was in front of them;
// the recall check asks again a day later, with nothing in front of them. It
// is drawn from the exercises of every lesson in the course (recite steps
// weighted heavily), served and graded exactly like an exam (exam.ts), and it
// opens no sooner than a day after the learner's last lesson or failed sitting,
// so the knowledge has to survive a gap. A certificate needs it passed.

import { createHash } from "node:crypto";
import type { CourseContent, CourseLesson, CourseStep } from "./content-schema";
import { examStepView, seededRandom, seededShuffle } from "./exam";

export const RECALL_PASS_MARK = 80;
export const RECALL_GAP_MS = 24 * 60 * 60 * 1000;
const RECALL_MIN = 8;
const RECALL_MAX = 20;
// A recital has to be produced from nothing; a choice can be recognised. The
// check leans on the first.
const RECITE_WEIGHT = 4;

export interface RecallCard {
  lessonId: string;
  /** The step's index in its lesson. */
  index: number;
  step: CourseStep;
}

/**
 * Every step the check can ask: all exercises except match, which marks each
 * pair right or wrong as it is made and so cannot be answered blind.
 */
export function recallPool(content: CourseContent): RecallCard[] {
  return content.units.flatMap((u) =>
    u.lessons.flatMap((l) =>
      l.steps.flatMap((step, index) =>
        step.type === "teach" || step.type === "match" ? [] : [{ lessonId: l.id, index, step }],
      ),
    ),
  );
}

/**
 * The cards for one sitting. One per lesson first, so every lesson is asked
 * about, then the rest by weight; sized by how many lessons there are, within
 * 8..20 and never more than the pool. Weighted sampling without replacement
 * (Efraimidis-Spirakis), so a recital is about four times as likely to be
 * picked as any other card. The same seed always draws the same cards in the
 * same order.
 */
export function drawRecall(content: CourseContent, seed: string): RecallCard[] {
  const pool = recallPool(content);
  const rand = seededRandom(`${seed}:draw`);
  const keyed = pool
    .map((card) => ({ card, key: rand() ** (1 / (card.step.type === "recite" ? RECITE_WEIGHT : 1)) }))
    .sort((a, b) => b.key - a.key);
  const lessonCount = new Set(pool.map((c) => c.lessonId)).size;
  const size = Math.min(pool.length, Math.max(RECALL_MIN, Math.min(RECALL_MAX, lessonCount)));

  const chosen: RecallCard[] = [];
  const asked = new Set<string>();
  for (const { card } of keyed) {
    if (chosen.length >= size) break;
    if (asked.has(card.lessonId)) continue;
    asked.add(card.lessonId);
    chosen.push(card);
  }
  for (const { card } of keyed) {
    if (chosen.length >= size) break;
    if (!chosen.includes(card)) chosen.push(card);
  }
  return seededShuffle(chosen, `${seed}:order`);
}

/**
 * A sitting is keyed by the learner, the course, how many times they have sat
 * it and the version of the content, so a resit draws new cards and an edit to
 * the course draws again. The id is what the browser sends back on submit.
 */
export function recallSeed(userId: string, courseId: string, attempts: number, contentUpdatedAt: Date): string {
  return `${courseId}:${userId}:${attempts}:${contentUpdatedAt.getTime()}`;
}

export function recallDrawId(seed: string): string {
  return createHash("sha256").update(seed).digest("hex").slice(0, 16);
}

/** The drawn cards as one exam lesson, so exam.ts grades it unchanged. */
export function recallLesson(cards: RecallCard[]): CourseLesson {
  return {
    id: "recall",
    title: "Recall check",
    exam: { passMark: RECALL_PASS_MARK },
    steps: cards.map((c) => c.step),
  };
}

/** The cards as the learner receives them: no answers, like an exam. */
export function recallView(cards: RecallCard[], seed: string): Record<string, unknown>[] {
  return cards.map((c, i) => examStepView(c.step, `${seed}:${i}`));
}

export interface LessonStanding {
  /** Lesson ids not yet finished (practice) or passed (exam). */
  missing: string[];
  /** Best score per finished lesson. */
  best: Map<string, number>;
  /** The learner's last activity on any lesson of the course, or null. */
  lastActivity: Date | null;
}

/**
 * Where a learner stands on the course as it is now. A practice lesson counts
 * once finished; an exam only from a server-graded sitting at or above the
 * pass mark it has now (SHAN-721).
 */
export function lessonStanding(
  content: CourseContent,
  progress: { lessonId: string; bestScore: number; updatedAt: Date }[],
  exams: { lessonId: string; bestScore: number; updatedAt: Date }[],
): LessonStanding {
  const lessons = content.units.flatMap((u) => u.lessons);
  const practice = new Map(progress.map((p) => [p.lessonId, p]));
  const exam = new Map(exams.map((e) => [e.lessonId, e]));
  const best = new Map<string, number>();
  let last = 0;
  for (const l of lessons) {
    const row = l.exam ? exam.get(l.id) : practice.get(l.id);
    if (!row) continue;
    const at = new Date(row.updatedAt).getTime();
    if (at > last) last = at;
    if (!l.exam || row.bestScore >= l.exam.passMark) best.set(l.id, row.bestScore);
  }
  return {
    missing: lessons.filter((l) => !best.has(l.id)).map((l) => l.id),
    best,
    lastActivity: last > 0 ? new Date(last) : null,
  };
}

/**
 * When the next sitting opens: a day after the later of the last lesson
 * activity and the last sitting. Practising a lesson again restarts the wait,
 * since a check taken an hour after a review measures the review.
 */
export function recallUnlocksAt(lastActivity: Date | null, lastSitting: Date | null): Date {
  const from = Math.max(lastActivity?.getTime() ?? 0, lastSitting?.getTime() ?? 0);
  return new Date(from + RECALL_GAP_MS);
}
