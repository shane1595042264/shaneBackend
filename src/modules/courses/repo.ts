// src/modules/courses/repo.ts
export const COURSE_CATEGORIES = [
  "math",
  "physics",
  "computer-science",
  "engineering",
  "biology",
  "chemistry",
  "history",
  "economics",
  "philosophy",
  "language",
  "art",
  "music",
  "other",
] as const;
export type CourseCategory = (typeof COURSE_CATEGORIES)[number];

export const COURSE_DIFFICULTIES = ["intro", "intermediate", "advanced"] as const;
export type CourseDifficulty = (typeof COURSE_DIFFICULTIES)[number];

import { and, asc, desc, eq, getTableColumns, inArray, lt, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { courseComments, courseCovers, courseRatings, courses, users } from "@/db/schema";

export interface CourseRow {
  id: string;
  userId: string;
  slug: string;
  url: string;
  title: string;
  description: string | null;
  category: string;
  difficulty: string;
  durationMinutes: number | null;
  tags: unknown;
  createdAt: Date;
  updatedAt: Date;
}

export async function createCourse(input: {
  userId: string;
  slug: string;
  url: string;
  title: string;
  description: string | null;
  category: CourseCategory;
  difficulty: CourseDifficulty;
  durationMinutes: number | null;
  tags: string[];
}): Promise<CourseRow> {
  const [row] = await db.insert(courses).values(input).returning();
  return row as CourseRow;
}

export async function listCourses(
  opts: { limit?: number; cursor?: string } = {},
): Promise<CourseRow[]> {
  const conditions = [];
  if (opts.cursor) {
    const cursorDate = new Date(opts.cursor);
    if (!Number.isNaN(cursorDate.getTime())) {
      conditions.push(lt(courses.createdAt, cursorDate));
    }
  }

  const query = db
    .select()
    .from(courses)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(courses.createdAt));

  const rows = opts.limit ? await query.limit(opts.limit) : await query;
  return rows as CourseRow[];
}

export async function getCourseById(id: string): Promise<CourseRow | null> {
  const [row] = await db.select().from(courses).where(eq(courses.id, id)).limit(1);
  return (row as CourseRow) ?? null;
}

export async function getCourseBySlug(slug: string): Promise<CourseRow | null> {
  const [row] = await db.select().from(courses).where(eq(courses.slug, slug)).limit(1);
  return (row as CourseRow) ?? null;
}

export async function getCourseByUrl(url: string): Promise<CourseRow | null> {
  const [row] = await db.select().from(courses).where(eq(courses.url, url)).limit(1);
  return (row as CourseRow) ?? null;
}

export async function slugTaken(slug: string): Promise<boolean> {
  const [row] = await db
    .select({ id: courses.id })
    .from(courses)
    .where(eq(courses.slug, slug))
    .limit(1);
  return row !== undefined;
}

export async function updateCourse(
  id: string,
  userId: string,
  patch: Partial<{
    title: string;
    description: string | null;
    category: CourseCategory;
    difficulty: CourseDifficulty;
    durationMinutes: number | null;
    tags: string[];
    url: string;
  }>,
): Promise<CourseRow | null> {
  const [row] = await db
    .update(courses)
    .set({ ...patch, updatedAt: new Date() })
    .where(and(eq(courses.id, id), eq(courses.userId, userId)))
    .returning();
  return (row as CourseRow) ?? null;
}

export async function deleteCourse(id: string, userId: string): Promise<boolean> {
  const rows = await db
    .delete(courses)
    .where(and(eq(courses.id, id), eq(courses.userId, userId)))
    .returning({ id: courses.id });
  return rows.length > 0;
}

// ---- covers ---------------------------------------------------------------

export async function upsertCover(
  courseId: string,
  mimeType: string,
  data: Buffer,
): Promise<void> {
  await db
    .insert(courseCovers)
    .values({ courseId, mimeType, byteSize: data.length, data })
    .onConflictDoUpdate({
      target: courseCovers.courseId,
      set: { mimeType, byteSize: data.length, data, updatedAt: new Date() },
    });
}

export async function getCover(
  courseId: string,
): Promise<{ mimeType: string; byteSize: number; data: Buffer } | null> {
  const [row] = await db
    .select({
      mimeType: courseCovers.mimeType,
      byteSize: courseCovers.byteSize,
      data: courseCovers.data,
    })
    .from(courseCovers)
    .where(eq(courseCovers.courseId, courseId))
    .limit(1);
  return row ?? null;
}

export async function deleteCoverRow(courseId: string): Promise<void> {
  await db.delete(courseCovers).where(eq(courseCovers.courseId, courseId));
}

/**
 * Cover timestamps for the courses on the current page. `courseIds` is
 * undefined only for callers that genuinely want the whole table; an empty
 * array means "this page has no rows", so skip the round trip entirely.
 */
export async function coverMeta(
  courseIds?: string[],
): Promise<{ courseId: string; updatedAt: Date }[]> {
  if (courseIds && courseIds.length === 0) return [];
  const query = db
    .select({ courseId: courseCovers.courseId, updatedAt: courseCovers.updatedAt })
    .from(courseCovers);
  return courseIds ? query.where(inArray(courseCovers.courseId, courseIds)) : query;
}

export async function coverMetaFor(
  courseId: string,
): Promise<{ updatedAt: Date } | null> {
  const [row] = await db
    .select({ updatedAt: courseCovers.updatedAt })
    .from(courseCovers)
    .where(eq(courseCovers.courseId, courseId))
    .limit(1);
  return row ?? null;
}

// ---- ratings --------------------------------------------------------------

export async function upsertRating(
  courseId: string,
  userId: string,
  stars: number,
): Promise<void> {
  await db
    .insert(courseRatings)
    .values({ courseId, userId, stars })
    .onConflictDoUpdate({
      target: [courseRatings.userId, courseRatings.courseId],
      set: { stars, updatedAt: new Date() },
    });
}

export async function deleteRating(courseId: string, userId: string): Promise<void> {
  await db
    .delete(courseRatings)
    .where(and(eq(courseRatings.courseId, courseId), eq(courseRatings.userId, userId)));
}

export async function ratingSummaries(
  courseIds?: string[],
): Promise<{ courseId: string; average: number | null; count: number }[]> {
  if (courseIds && courseIds.length === 0) return [];
  return db
    .select({
      courseId: courseRatings.courseId,
      average: sql<number>`avg(${courseRatings.stars})::float`,
      count: sql<number>`count(*)::int`,
    })
    .from(courseRatings)
    .where(courseIds ? inArray(courseRatings.courseId, courseIds) : undefined)
    .groupBy(courseRatings.courseId);
}

export async function ratingSummaryFor(
  courseId: string,
): Promise<{ average: number | null; count: number }> {
  const [row] = await db
    .select({
      average: sql<number>`avg(${courseRatings.stars})::float`,
      count: sql<number>`count(*)::int`,
    })
    .from(courseRatings)
    .where(eq(courseRatings.courseId, courseId))
    .groupBy(courseRatings.courseId);
  return row ?? { average: null, count: 0 };
}

export async function myRatings(
  userId: string,
  courseIds?: string[],
): Promise<{ courseId: string; stars: number }[]> {
  if (courseIds && courseIds.length === 0) return [];
  return db
    .select({ courseId: courseRatings.courseId, stars: courseRatings.stars })
    .from(courseRatings)
    .where(
      courseIds
        ? and(
            eq(courseRatings.userId, userId),
            inArray(courseRatings.courseId, courseIds),
          )
        : eq(courseRatings.userId, userId),
    );
}

export async function myRatingFor(
  courseId: string,
  userId: string,
): Promise<number | null> {
  const [row] = await db
    .select({ stars: courseRatings.stars })
    .from(courseRatings)
    .where(and(eq(courseRatings.courseId, courseId), eq(courseRatings.userId, userId)))
    .limit(1);
  return row?.stars ?? null;
}

// ---- comments -------------------------------------------------------------

export async function commentCounts(
  courseIds?: string[],
): Promise<{ courseId: string; count: number }[]> {
  if (courseIds && courseIds.length === 0) return [];
  return db
    .select({
      courseId: courseComments.courseId,
      count: sql<number>`count(*)::int`,
    })
    .from(courseComments)
    .where(courseIds ? inArray(courseComments.courseId, courseIds) : undefined)
    .groupBy(courseComments.courseId);
}

export async function commentCountFor(courseId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(courseComments)
    .where(eq(courseComments.courseId, courseId));
  return row?.count ?? 0;
}

export async function createCourseComment(input: {
  courseId: string;
  authorId: string;
  content: string;
  parentCommentId?: string | null;
}) {
  const [row] = await db
    .insert(courseComments)
    .values({
      courseId: input.courseId,
      authorId: input.authorId,
      content: input.content,
      parentCommentId: input.parentCommentId ?? null,
    })
    .returning();
  return row;
}

export async function listCourseComments(courseId: string) {
  const rows = await db
    .select({
      ...getTableColumns(courseComments),
      authorName: users.name,
      authorAvatarUrl: users.avatarUrl,
    })
    .from(courseComments)
    .leftJoin(users, eq(users.id, courseComments.authorId))
    .where(eq(courseComments.courseId, courseId))
    .orderBy(asc(courseComments.createdAt));

  return rows.map(({ authorName, authorAvatarUrl, ...comment }) => ({
    ...comment,
    author: comment.authorId
      ? { id: comment.authorId, name: authorName, avatarUrl: authorAvatarUrl }
      : null,
  }));
}

export async function getCourseComment(id: string) {
  const [row] = await db
    .select()
    .from(courseComments)
    .where(eq(courseComments.id, id))
    .limit(1);
  return row ?? null;
}

export async function updateCourseComment(
  commentId: string,
  authorId: string,
  content: string,
) {
  const [row] = await db
    .update(courseComments)
    .set({ content, editedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(courseComments.id, commentId), eq(courseComments.authorId, authorId)))
    .returning();
  return row ?? null;
}

// Comment author OR course owner can delete (knowledge pattern).
export async function deleteCourseComment(
  commentId: string,
  callerId: string,
): Promise<boolean> {
  const [row] = await db
    .select({
      commentId: courseComments.id,
      commentAuthor: courseComments.authorId,
      courseOwner: courses.userId,
    })
    .from(courseComments)
    .innerJoin(courses, eq(courses.id, courseComments.courseId))
    .where(eq(courseComments.id, commentId))
    .limit(1);
  if (!row) return false;
  if (row.commentAuthor !== callerId && row.courseOwner !== callerId) return false;
  await db.delete(courseComments).where(eq(courseComments.id, commentId));
  return true;
}
