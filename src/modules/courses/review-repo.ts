// src/modules/courses/review-repo.ts
// SHAN-723: certification reviews (course_reviews).
//
// A row is "pending" until the reviewer answers, then "approved" or
// "rejected". A pending row whose course was edited before the answer came is
// "superseded": the edit queued a review of its own, and a verdict on a
// version nobody can take any more means nothing.
import { and, asc, desc, eq, isNull, lt, or, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { courseReviews, courses } from "@/db/schema";

export type ReviewStatus = "pending" | "approved" | "rejected" | "superseded";

export interface ReviewRow {
  id: string;
  courseId: string;
  submittedBy: string;
  contentHash: string;
  status: ReviewStatus;
  summary: string | null;
  feedback: string[];
  modelUsed: string | null;
  attempts: number;
  lastAttemptAt: Date | null;
  reviewedAt: Date | null;
  createdAt: Date;
}

function asRow(r: typeof courseReviews.$inferSelect): ReviewRow {
  return {
    ...r,
    status: r.status as ReviewStatus,
    feedback: Array.isArray(r.feedback) ? (r.feedback as string[]) : [],
  };
}

export async function getReview(id: string): Promise<ReviewRow | null> {
  const [row] = await db.select().from(courseReviews).where(eq(courseReviews.id, id)).limit(1);
  return row ? asRow(row) : null;
}

/** The course's newest submission, whatever became of it. */
export async function latestReview(courseId: string): Promise<ReviewRow | null> {
  const [row] = await db
    .select()
    .from(courseReviews)
    .where(eq(courseReviews.courseId, courseId))
    .orderBy(desc(courseReviews.createdAt), desc(courseReviews.id))
    .limit(1);
  return row ? asRow(row) : null;
}

/** Queue a review of one version, retiring any still waiting on an older one. */
export async function createReview(input: {
  courseId: string;
  submittedBy: string;
  contentHash: string;
}): Promise<ReviewRow> {
  return db.transaction(async (tx) => {
    await tx
      .update(courseReviews)
      .set({ status: "superseded" })
      .where(and(eq(courseReviews.courseId, input.courseId), eq(courseReviews.status, "pending")));
    const [row] = await tx.insert(courseReviews).values(input).returning();
    return asRow(row);
  });
}

/** One try at reviewing, counted whether or not it gets an answer. */
export async function markAttempt(id: string): Promise<void> {
  await db
    .update(courseReviews)
    .set({ attempts: sql`${courseReviews.attempts} + 1`, lastAttemptAt: new Date() })
    .where(eq(courseReviews.id, id));
}

/**
 * Record the verdict, only if the row is still pending: a submission that was
 * superseded while the model was thinking keeps that status. True when written.
 */
export async function finishReview(
  id: string,
  verdict: { status: "approved" | "rejected" | "superseded"; summary?: string; feedback?: string[]; modelUsed?: string },
): Promise<boolean> {
  const rows = await db
    .update(courseReviews)
    .set({
      status: verdict.status,
      summary: verdict.summary ?? null,
      feedback: verdict.feedback ?? [],
      modelUsed: verdict.modelUsed ?? null,
      reviewedAt: new Date(),
    })
    .where(and(eq(courseReviews.id, id), eq(courseReviews.status, "pending")))
    .returning({ id: courseReviews.id });
  return rows.length > 0;
}

/**
 * Apply a verdict to the course, only while this review is still the course's
 * newest submission (SHAN-724). An edit saved while the model was reading
 * queues a newer review, and the old verdict must not certify lessons nobody
 * has read. One statement, so no submission can slip in between the check and
 * the write. True when written.
 */
export async function certifyIfLatest(courseId: string, reviewId: string, certified: boolean): Promise<boolean> {
  const rows = await db
    .update(courses)
    .set({ certified, updatedAt: new Date() })
    .where(
      and(
        eq(courses.id, courseId),
        sql`not exists (
          select 1 from course_reviews newer
          where newer.course_id = ${courseId}
            and newer.created_at > (select created_at from course_reviews where id = ${reviewId})
        )`,
      ),
    )
    .returning({ id: courses.id });
  return rows.length > 0;
}

/** Pending reviews nobody has tried since `before`, with tries left, oldest first. */
export async function stalePendingReviews(before: Date, maxAttempts: number, limit = 5): Promise<string[]> {
  const rows = await db
    .select({ id: courseReviews.id })
    .from(courseReviews)
    .where(
      and(
        eq(courseReviews.status, "pending"),
        lt(courseReviews.attempts, maxAttempts),
        or(isNull(courseReviews.lastAttemptAt), lt(courseReviews.lastAttemptAt, before)),
      ),
    )
    .orderBy(asc(courseReviews.createdAt))
    .limit(limit);
  return rows.map((r) => r.id);
}
