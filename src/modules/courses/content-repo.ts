// src/modules/courses/content-repo.ts
// Interactive lessons (course_content), learner progress (course_progress),
// exam results (course_exam_results, SHAN-721) and recall checks
// (course_recall_results, SHAN-722).
import { and, eq, inArray, isNotNull, isNull, lte, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { courseContent, courseExamResults, courseProgress, courseRecallResults } from "@/db/schema";
import type { ContentStats, CourseContent } from "./content-schema";
import { EXAM_RESIT_GAP_MS } from "./exam";
import { RECALL_GAP_MS } from "./recall";

export interface ContentRow {
  content: CourseContent;
  lessonCount: number;
  stepCount: number;
  updatedAt: Date;
}

export async function getContent(courseId: string): Promise<ContentRow | null> {
  const [row] = await db
    .select({
      content: courseContent.content,
      lessonCount: courseContent.lessonCount,
      stepCount: courseContent.stepCount,
      updatedAt: courseContent.updatedAt,
    })
    .from(courseContent)
    .where(eq(courseContent.courseId, courseId))
    .limit(1);
  return row ? ({ ...row, content: row.content as CourseContent } as ContentRow) : null;
}

export async function upsertContent(
  courseId: string,
  content: CourseContent,
  stats: ContentStats,
): Promise<{ updatedAt: Date }> {
  const now = new Date();
  const [row] = await db
    .insert(courseContent)
    .values({ courseId, content, lessonCount: stats.lessons, stepCount: stats.steps })
    .onConflictDoUpdate({
      target: courseContent.courseId,
      set: { content, lessonCount: stats.lessons, stepCount: stats.steps, updatedAt: now },
    })
    .returning({ updatedAt: courseContent.updatedAt });
  return row;
}

export async function deleteContent(courseId: string): Promise<boolean> {
  const rows = await db
    .delete(courseContent)
    .where(eq(courseContent.courseId, courseId))
    .returning({ courseId: courseContent.courseId });
  return rows.length > 0;
}

/** Lesson counts for the courses on a catalog page; never reads the document. */
export async function contentMeta(
  courseIds: string[],
): Promise<{ courseId: string; lessonCount: number; stepCount: number }[]> {
  if (courseIds.length === 0) return [];
  return db
    .select({
      courseId: courseContent.courseId,
      lessonCount: courseContent.lessonCount,
      stepCount: courseContent.stepCount,
    })
    .from(courseContent)
    .where(inArray(courseContent.courseId, courseIds));
}

export async function contentMetaFor(
  courseId: string,
): Promise<{ lessonCount: number; stepCount: number } | null> {
  const [row] = await contentMeta([courseId]);
  return row ? { lessonCount: row.lessonCount, stepCount: row.stepCount } : null;
}

export interface ProgressRow {
  lessonId: string;
  bestScore: number;
  lastScore: number;
  attempts: number;
  completedAt: Date;
  updatedAt: Date;
}

const progressColumns = {
  lessonId: courseProgress.lessonId,
  bestScore: courseProgress.bestScore,
  lastScore: courseProgress.lastScore,
  attempts: courseProgress.attempts,
  completedAt: courseProgress.completedAt,
  updatedAt: courseProgress.updatedAt,
};

export async function listProgress(userId: string, courseId: string): Promise<ProgressRow[]> {
  return db
    .select(progressColumns)
    .from(courseProgress)
    .where(and(eq(courseProgress.userId, userId), eq(courseProgress.courseId, courseId)));
}

/**
 * Record one finished run of a lesson. The first run sets completed_at; later
 * runs bump attempts, keep the best score and remember the latest.
 */
export async function recordProgress(
  userId: string,
  courseId: string,
  lessonId: string,
  score: number,
): Promise<ProgressRow> {
  const [row] = await db
    .insert(courseProgress)
    .values({ userId, courseId, lessonId, bestScore: score, lastScore: score })
    .onConflictDoUpdate({
      target: [courseProgress.userId, courseProgress.courseId, courseProgress.lessonId],
      set: {
        attempts: sql`${courseProgress.attempts} + 1`,
        bestScore: sql`greatest(${courseProgress.bestScore}, excluded.best_score)`,
        lastScore: sql`excluded.last_score`,
        updatedAt: new Date(),
      },
    })
    .returning(progressColumns);
  return row;
}

export async function resetProgress(userId: string, courseId: string): Promise<void> {
  await db
    .delete(courseProgress)
    .where(and(eq(courseProgress.userId, userId), eq(courseProgress.courseId, courseId)));
  // SHAN-726: a sitting from the last day stays, so clearing progress cannot
  // skip the wait before an exam's next sitting.
  await db
    .delete(courseExamResults)
    .where(
      and(
        eq(courseExamResults.userId, userId),
        eq(courseExamResults.courseId, courseId),
        lte(courseExamResults.updatedAt, new Date(Date.now() - EXAM_RESIT_GAP_MS)),
      ),
    );
  // SHAN-727: and a recall check not yet passed stays. Its attempts seed the
  // next draw, so clearing it would serve the first sitting's cards again,
  // already marked right or wrong.
  await db
    .delete(courseRecallResults)
    .where(
      and(
        eq(courseRecallResults.userId, userId),
        eq(courseRecallResults.courseId, courseId),
        isNotNull(courseRecallResults.passedAt),
      ),
    );
}

export interface ExamResultRow {
  lessonId: string;
  bestScore: number;
  lastScore: number;
  attempts: number;
  passedAt: Date | null;
  updatedAt: Date;
}

export async function listExamResults(userId: string, courseId: string): Promise<ExamResultRow[]> {
  return db
    .select({
      lessonId: courseExamResults.lessonId,
      bestScore: courseExamResults.bestScore,
      lastScore: courseExamResults.lastScore,
      attempts: courseExamResults.attempts,
      passedAt: courseExamResults.passedAt,
      updatedAt: courseExamResults.updatedAt,
    })
    .from(courseExamResults)
    .where(and(eq(courseExamResults.userId, userId), eq(courseExamResults.courseId, courseId)));
}

/**
 * Record one graded sitting. The best score is kept, and passed_at is set by
 * the first sitting that passed and never cleared by a worse one after it.
 *
 * SHAN-726: with `wait`, the sitting is recorded only if the last one is a
 * day old, in the same statement, and null comes back otherwise. Checking
 * first and writing after would let a burst of parallel sittings through,
 * each one telling the learner which answers were wrong.
 */
export async function recordExamResult(
  userId: string,
  courseId: string,
  lessonId: string,
  score: number,
  passed: boolean,
  wait = true,
): Promise<ExamResultRow | null> {
  const now = new Date();
  const [row] = await db
    .insert(courseExamResults)
    .values({
      userId,
      courseId,
      lessonId,
      bestScore: score,
      lastScore: score,
      passedAt: passed ? now : null,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [courseExamResults.userId, courseExamResults.courseId, courseExamResults.lessonId],
      set: {
        attempts: sql`${courseExamResults.attempts} + 1`,
        bestScore: sql`greatest(${courseExamResults.bestScore}, excluded.best_score)`,
        lastScore: sql`excluded.last_score`,
        passedAt: sql`coalesce(${courseExamResults.passedAt}, excluded.passed_at)`,
        updatedAt: now,
      },
      ...(wait
        ? { setWhere: lte(courseExamResults.updatedAt, new Date(now.getTime() - EXAM_RESIT_GAP_MS)) }
        : {}),
    })
    .returning({
      lessonId: courseExamResults.lessonId,
      bestScore: courseExamResults.bestScore,
      lastScore: courseExamResults.lastScore,
      attempts: courseExamResults.attempts,
      passedAt: courseExamResults.passedAt,
      updatedAt: courseExamResults.updatedAt,
    });
  return row ?? null;
}

export interface RecallResultRow {
  bestScore: number;
  lastScore: number;
  attempts: number;
  passedAt: Date | null;
  updatedAt: Date;
}

const recallColumns = {
  bestScore: courseRecallResults.bestScore,
  lastScore: courseRecallResults.lastScore,
  attempts: courseRecallResults.attempts,
  passedAt: courseRecallResults.passedAt,
  updatedAt: courseRecallResults.updatedAt,
};

export async function getRecallResult(userId: string, courseId: string): Promise<RecallResultRow | null> {
  const [row] = await db
    .select(recallColumns)
    .from(courseRecallResults)
    .where(and(eq(courseRecallResults.userId, userId), eq(courseRecallResults.courseId, courseId)))
    .limit(1);
  return row ?? null;
}

/**
 * Record one graded recall sitting; same keep-the-best rules as an exam, and
 * (SHAN-726) the same guard in the statement: a sitting lands only on a check
 * not yet passed whose last sitting is a day old, else null.
 */
export async function recordRecallResult(
  userId: string,
  courseId: string,
  score: number,
  passed: boolean,
): Promise<RecallResultRow | null> {
  const now = new Date();
  const [row] = await db
    .insert(courseRecallResults)
    .values({ userId, courseId, bestScore: score, lastScore: score, passedAt: passed ? now : null, updatedAt: now })
    .onConflictDoUpdate({
      target: [courseRecallResults.userId, courseRecallResults.courseId],
      set: {
        attempts: sql`${courseRecallResults.attempts} + 1`,
        bestScore: sql`greatest(${courseRecallResults.bestScore}, excluded.best_score)`,
        lastScore: sql`excluded.last_score`,
        passedAt: sql`coalesce(${courseRecallResults.passedAt}, excluded.passed_at)`,
        updatedAt: now,
      },
      setWhere: and(
        isNull(courseRecallResults.passedAt),
        lte(courseRecallResults.updatedAt, new Date(now.getTime() - RECALL_GAP_MS)),
      ),
    })
    .returning(recallColumns);
  return row ?? null;
}
