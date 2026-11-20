// src/modules/courses/content-repo.ts
// Interactive lessons (course_content), learner progress (course_progress) and
// exam results (course_exam_results, SHAN-721).
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { courseContent, courseExamResults, courseProgress } from "@/db/schema";
import type { ContentStats, CourseContent } from "./content-schema";

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
  await db
    .delete(courseExamResults)
    .where(and(eq(courseExamResults.userId, userId), eq(courseExamResults.courseId, courseId)));
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
 */
export async function recordExamResult(
  userId: string,
  courseId: string,
  lessonId: string,
  score: number,
  passed: boolean,
): Promise<ExamResultRow> {
  const now = new Date();
  const [row] = await db
    .insert(courseExamResults)
    .values({ userId, courseId, lessonId, bestScore: score, lastScore: score, passedAt: passed ? now : null })
    .onConflictDoUpdate({
      target: [courseExamResults.userId, courseExamResults.courseId, courseExamResults.lessonId],
      set: {
        attempts: sql`${courseExamResults.attempts} + 1`,
        bestScore: sql`greatest(${courseExamResults.bestScore}, excluded.best_score)`,
        lastScore: sql`excluded.last_score`,
        passedAt: sql`coalesce(${courseExamResults.passedAt}, excluded.passed_at)`,
        updatedAt: now,
      },
    })
    .returning({
      lessonId: courseExamResults.lessonId,
      bestScore: courseExamResults.bestScore,
      lastScore: courseExamResults.lastScore,
      attempts: courseExamResults.attempts,
      passedAt: courseExamResults.passedAt,
      updatedAt: courseExamResults.updatedAt,
    });
  return row;
}
