// src/modules/courses/review-runner.ts
//
// SHAN-723: runs certification reviews in the background. A review reads a
// whole course through the main LLM chain, which can take a minute, so the
// submit endpoint answers 202 and the editor polls GET /:id/review.
//
// A provider outage, or an answer the reviewer cannot act on, leaves the
// submission pending: the cron sweep tries it again, and an author who submits
// the same version again kicks it at once. Nothing but a real verdict ever
// rejects a course.

import { getCourseById } from "./repo";
import { getContent } from "./content-repo";
import { setCertified } from "./certificate-repo";
import { contentHash, reviewCourse } from "./review";
import {
  finishReview,
  getReview,
  markAttempt,
  stalePendingReviews,
  type ReviewRow,
} from "./review-repo";

/** A pending review is retried once nobody has tried it for this long. */
export const RETRY_AFTER_MS = 10 * 60_000;
/** After this many tries the sweep stops; resubmitting still kicks it. */
export const MAX_SWEEP_ATTEMPTS = 48;

// One container, so an in-process set is enough to keep the submit kick and
// the cron sweep from reviewing the same submission twice at once.
const running = new Set<string>();

export async function runReview(id: string): Promise<ReviewRow | null> {
  if (running.has(id)) return null;
  running.add(id);
  try {
    const review = await getReview(id);
    if (!review || review.status !== "pending") return review;
    await markAttempt(id);
    const course = await getCourseById(review.courseId);
    const content = course ? await getContent(course.id) : null;
    // The course moved on under the submission: deleted, made private, its
    // lessons removed or edited. An edit queues its own review.
    if (
      !course ||
      !content ||
      course.visibility === "private" ||
      contentHash(content.content) !== review.contentHash
    ) {
      await finishReview(id, { status: "superseded" });
      return getReview(id);
    }
    let verdict;
    try {
      verdict = await reviewCourse(
        {
          title: course.title,
          description: course.description,
          difficulty: course.difficulty,
          tags: Array.isArray(course.tags) ? (course.tags as string[]) : [],
        },
        content.content,
      );
    } catch (err) {
      console.warn(`[courses] review ${id} left pending:`, (err as Error).message.slice(0, 300));
      return getReview(id);
    }
    const written = await finishReview(id, {
      status: verdict.approved ? "approved" : "rejected",
      summary: verdict.summary,
      feedback: verdict.feedback,
      modelUsed: verdict.modelUsed.slice(0, 80),
    });
    // Not written = superseded while the model read it; the newer review decides.
    if (written) await setCertified(course.id, verdict.approved);
    console.log(`[courses] review ${id}: ${verdict.approved ? "approved" : "rejected"} by ${verdict.modelUsed}`);
    return getReview(id);
  } finally {
    running.delete(id);
  }
}

/** Fire and forget, for a request handler that has already answered. */
export function startReview(id: string): void {
  void runReview(id).catch((err) => {
    console.error(`[courses] review ${id} failed:`, (err as Error).message);
  });
}

/** Cron: retry pending reviews nobody has tried lately, one at a time. */
export async function retryPendingReviews(): Promise<void> {
  const ids = await stalePendingReviews(new Date(Date.now() - RETRY_AFTER_MS), MAX_SWEEP_ATTEMPTS);
  for (const id of ids) {
    await runReview(id).catch((err) => {
      console.error(`[courses] review ${id} failed:`, (err as Error).message);
    });
  }
}
