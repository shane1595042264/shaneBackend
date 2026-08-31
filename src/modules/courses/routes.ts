// src/modules/courses/routes.ts
import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { optionalAuth, requireAuth, requireScope } from "@/modules/auth/middleware";
import { createPATRateLimit } from "@/modules/shared/rate-limit";
import { sniffImageMime } from "@/modules/shared/image-validate";
import {
  trimmedNullish,
  trimmedOptional,
  trimmedLabels,
} from "@/modules/shared/validators";
import { generateUniqueSlug } from "@/modules/trips/slug";
import { CourseFetchError, classifyCourse, fetchCourseText } from "./classifier";
import {
  COURSE_CATEGORIES,
  COURSE_DIFFICULTIES,
  type CourseRow,
  createCourse,
  listCourses,
  getCourseById,
  getCourseBySlug,
  getCourseByUrl,
  slugTaken,
  updateCourse,
  deleteCourse,
  upsertCover,
  getCover,
  deleteCoverRow,
  coverMeta,
  coverMetaFor,
  upsertRating,
  deleteRating,
  ratingSummaries,
  ratingSummaryFor,
  myRatings,
  myRatingFor,
  commentCounts,
  commentCountFor,
  createCourseComment,
  listCourseComments,
  updateCourseComment,
  deleteCourseComment,
} from "./repo";

// Per-PAT 60s rolling write limit. JWT browser sessions bypass. Distinct
// bucket so a busy courses session doesn't lock out other modules.
const coursesWriteLimit = createPATRateLimit({
  bucket: "courses-write",
  limitPerMinute: 60,
});

type Vars = { Variables: { userId: string | null; tokenScopes: string[] | null } };
export const coursesRoutes = new Hono<Vars>();

const COVER_MAX_BYTES = 5 * 1024 * 1024;

const idParam = z.object({ id: z.string().uuid() });
const courseIdParam = z.object({ courseId: z.string().uuid() });
const slugParam = z.object({ slug: z.string().trim().min(1).max(80) });
const urlSchema = z.string().trim().url().max(2048);

const createBody = z.object({
  url: urlSchema,
  title: trimmedOptional(200),
});

const patchBody = z
  .object({
    title: trimmedOptional(200),
    description: trimmedNullish(2000),
    category: z.enum(COURSE_CATEGORIES).optional(),
    difficulty: z.enum(COURSE_DIFFICULTIES).optional(),
    durationMinutes: z.number().int().min(1).max(100_000).nullish(),
    tags: trimmedLabels(40, 8),
    url: urlSchema.optional(),
  })
  .refine(
    (b) =>
      b.title !== undefined ||
      b.description !== undefined ||
      b.category !== undefined ||
      b.difficulty !== undefined ||
      b.durationMinutes !== undefined ||
      b.tags !== undefined ||
      b.url !== undefined,
    { message: "At least one field is required" },
  );

const ratingBody = z.object({ stars: z.number().int().min(1).max(5) });

const commentBody = z.object({
  content: z.string().trim().min(1).max(10_000),
  parent_comment_id: z.string().uuid().optional(),
});

interface CourseMeta {
  coverUpdatedAt: Date | null;
  average: number | null;
  count: number;
  commentCount: number;
  myStars: number | null;
}

function coverUrlFor(courseId: string, coverUpdatedAt: Date | null): string | null {
  if (!coverUpdatedAt) return null;
  return `/api/courses/covers/${courseId}?v=${new Date(coverUpdatedAt).getTime()}`;
}

function serializeCourse(row: CourseRow, meta: CourseMeta) {
  return {
    id: row.id,
    slug: row.slug,
    url: row.url,
    title: row.title,
    description: row.description,
    category: row.category,
    difficulty: row.difficulty,
    durationMinutes: row.durationMinutes,
    tags: Array.isArray(row.tags) ? row.tags : [],
    ownerId: row.userId,
    coverUrl: coverUrlFor(row.id, meta.coverUpdatedAt),
    rating: { average: meta.average, count: meta.count },
    commentCount: meta.commentCount,
    myStars: meta.myStars,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

const EMPTY_META: CourseMeta = {
  coverUpdatedAt: null,
  average: null,
  count: 0,
  commentCount: 0,
  myStars: null,
};

async function metaFor(courseId: string, userId: string | null): Promise<CourseMeta> {
  const [cover, rating, comments, mine] = await Promise.all([
    coverMetaFor(courseId),
    ratingSummaryFor(courseId),
    commentCountFor(courseId),
    userId ? myRatingFor(courseId, userId) : Promise.resolve(null),
  ]);
  return {
    coverUpdatedAt: cover?.updatedAt ?? null,
    average: rating.average,
    count: rating.count,
    commentCount: comments,
    myStars: mine,
  };
}

// ---- Public reads --------------------------------------------------------

// Cover bytes. No auth: uuid-addressed and <img> cannot send Authorization.
// Immutable cache is safe because the URL carries ?v=<updatedAt>.
coursesRoutes.get(
  "/covers/:courseId",
  zValidator("param", courseIdParam),
  async (c) => {
    const { courseId } = c.req.valid("param");
    const row = await getCover(courseId);
    if (!row) return c.json({ error: "Not found" }, 404);
    return new Response(new Uint8Array(row.data), {
      status: 200,
      headers: {
        "Content-Type": row.mimeType,
        "Content-Length": String(row.byteSize),
        "Cache-Control": "public, max-age=31536000, immutable",
        "X-Content-Type-Options": "nosniff",
        "Content-Disposition": "inline",
      },
    });
  },
);

coursesRoutes.get("/", optionalAuth, async (c) => {
  const userId = c.get("userId");
  const [rows, covers, ratings, comments, mine] = await Promise.all([
    listCourses(),
    coverMeta(),
    ratingSummaries(),
    commentCounts(),
    userId ? myRatings(userId) : Promise.resolve([]),
  ]);
  const coverBy = new Map(covers.map((r) => [r.courseId, r.updatedAt]));
  const ratingBy = new Map(ratings.map((r) => [r.courseId, r]));
  const commentBy = new Map(comments.map((r) => [r.courseId, r.count]));
  const mineBy = new Map(mine.map((r) => [r.courseId, r.stars]));
  return c.json({
    courses: rows.map((row) =>
      serializeCourse(row, {
        coverUpdatedAt: coverBy.get(row.id) ?? null,
        average: ratingBy.get(row.id)?.average ?? null,
        count: ratingBy.get(row.id)?.count ?? 0,
        commentCount: commentBy.get(row.id) ?? 0,
        myStars: mineBy.get(row.id) ?? null,
      }),
    ),
  });
});

coursesRoutes.get(
  "/:slug",
  optionalAuth,
  zValidator("param", slugParam),
  async (c) => {
    const { slug } = c.req.valid("param");
    const row = await getCourseBySlug(slug);
    if (!row) return c.json({ error: "Not found" }, 404);
    const meta = await metaFor(row.id, c.get("userId"));
    return c.json({ course: serializeCourse(row, meta) });
  },
);

// ---- Course writes (owner only) ------------------------------------------

coursesRoutes.post(
  "/",
  requireAuth,
  requireScope("entries:write"),
  coursesWriteLimit,
  zValidator("json", createBody),
  async (c) => {
    const userId = c.get("userId") as string;
    const body = c.req.valid("json");
    const existing = await getCourseByUrl(body.url);
    if (existing) {
      return c.json({ error: "A course with this URL already exists" }, 409);
    }
    let text: string;
    try {
      text = await fetchCourseText(body.url);
    } catch (err) {
      const message =
        err instanceof CourseFetchError ? err.message : "Could not fetch course page";
      return c.json({ error: message }, 502);
    }
    const ai = await classifyCourse(text, body.url);
    const title = body.title ?? ai.title;
    const slug = await generateUniqueSlug(title, slugTaken);
    const row = await createCourse({
      userId,
      slug,
      url: body.url,
      title,
      description: ai.description,
      category: ai.category,
      difficulty: ai.difficulty,
      durationMinutes: ai.durationMinutes,
      tags: ai.tags,
    });
    return c.json({ course: serializeCourse(row, EMPTY_META) }, 201);
  },
);

coursesRoutes.patch(
  "/:id",
  requireAuth,
  requireScope("entries:write"),
  coursesWriteLimit,
  zValidator("param", idParam),
  zValidator("json", patchBody),
  async (c) => {
    const userId = c.get("userId") as string;
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    if (body.url !== undefined) {
      const clash = await getCourseByUrl(body.url);
      if (clash && clash.id !== id) {
        return c.json({ error: "A course with this URL already exists" }, 409);
      }
    }
    const row = await updateCourse(id, userId, body);
    if (!row) return c.json({ error: "Not found" }, 404);
    const meta = await metaFor(row.id, userId);
    return c.json({ course: serializeCourse(row, meta) });
  },
);

coursesRoutes.post(
  "/:id/reclassify",
  requireAuth,
  requireScope("entries:write"),
  coursesWriteLimit,
  zValidator("param", idParam),
  async (c) => {
    const userId = c.get("userId") as string;
    const { id } = c.req.valid("param");
    const course = await getCourseById(id);
    if (!course || course.userId !== userId) {
      return c.json({ error: "Not found" }, 404);
    }
    let text: string;
    try {
      text = await fetchCourseText(course.url);
    } catch (err) {
      const message =
        err instanceof CourseFetchError ? err.message : "Could not fetch course page";
      return c.json({ error: message }, 502);
    }
    const ai = await classifyCourse(text, course.url);
    // Title and slug are deliberately preserved: links stay stable and a
    // hand-edited title is not clobbered by a re-run.
    const row = await updateCourse(id, userId, {
      description: ai.description,
      category: ai.category,
      difficulty: ai.difficulty,
      durationMinutes: ai.durationMinutes,
      tags: ai.tags,
    });
    if (!row) return c.json({ error: "Not found" }, 404);
    const meta = await metaFor(row.id, userId);
    return c.json({ course: serializeCourse(row, meta) });
  },
);

coursesRoutes.delete(
  "/:id",
  requireAuth,
  requireScope("entries:write"),
  coursesWriteLimit,
  zValidator("param", idParam),
  async (c) => {
    const userId = c.get("userId") as string;
    const { id } = c.req.valid("param");
    const removed = await deleteCourse(id, userId);
    if (!removed) return c.json({ error: "Not found" }, 404);
    return c.body(null, 204);
  },
);

// ---- Cover upload --------------------------------------------------------

coursesRoutes.put(
  "/:id/cover",
  requireAuth,
  requireScope("entries:write"),
  coursesWriteLimit,
  zValidator("param", idParam),
  async (c) => {
    const userId = c.get("userId") as string;
    const { id } = c.req.valid("param");
    const course = await getCourseById(id);
    if (!course || course.userId !== userId) {
      return c.json({ error: "Not found" }, 404);
    }
    const contentType = c.req.header("Content-Type") ?? "";
    if (!contentType.includes("multipart/form-data")) {
      return c.json({ error: "Expected multipart/form-data with a 'file' field" }, 400);
    }
    const form = await c.req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return c.json({ error: "Missing 'file' in multipart upload" }, 400);
    }
    if (file.size === 0) return c.json({ error: "Empty file" }, 400);
    if (file.size > COVER_MAX_BYTES) {
      return c.json({ error: "Cover too large (max 5MB)" }, 413);
    }
    const buffer = Buffer.from(await file.arrayBuffer());
    const mime = sniffImageMime(buffer);
    if (!mime) {
      return c.json({ error: "Unsupported image type - png/jpeg/gif/webp only" }, 415);
    }
    await upsertCover(id, mime, buffer);
    return c.json({ coverUrl: `/api/courses/covers/${id}?v=${Date.now()}` });
  },
);

coursesRoutes.delete(
  "/:id/cover",
  requireAuth,
  requireScope("entries:write"),
  coursesWriteLimit,
  zValidator("param", idParam),
  async (c) => {
    const userId = c.get("userId") as string;
    const { id } = c.req.valid("param");
    const course = await getCourseById(id);
    if (!course || course.userId !== userId) {
      return c.json({ error: "Not found" }, 404);
    }
    await deleteCoverRow(id);
    return c.body(null, 204);
  },
);

// ---- Ratings (any signed-in user) ----------------------------------------

coursesRoutes.put(
  "/:id/rating",
  requireAuth,
  requireScope("reactions:write"),
  coursesWriteLimit,
  zValidator("param", idParam),
  zValidator("json", ratingBody),
  async (c) => {
    const userId = c.get("userId") as string;
    const { id } = c.req.valid("param");
    const { stars } = c.req.valid("json");
    const course = await getCourseById(id);
    if (!course) return c.json({ error: "Not found" }, 404);
    await upsertRating(id, userId, stars);
    const summary = await ratingSummaryFor(id);
    return c.json({ rating: { ...summary, mine: stars } });
  },
);

coursesRoutes.delete(
  "/:id/rating",
  requireAuth,
  requireScope("reactions:write"),
  coursesWriteLimit,
  zValidator("param", idParam),
  async (c) => {
    const userId = c.get("userId") as string;
    const { id } = c.req.valid("param");
    const course = await getCourseById(id);
    if (!course) return c.json({ error: "Not found" }, 404);
    await deleteRating(id, userId);
    const summary = await ratingSummaryFor(id);
    return c.json({ rating: { ...summary, mine: null } });
  },
);

// ---- Comments (any signed-in user) ---------------------------------------

coursesRoutes.get(
  "/:id/comments",
  optionalAuth,
  zValidator("param", idParam),
  async (c) => {
    const { id } = c.req.valid("param");
    const course = await getCourseById(id);
    if (!course) return c.json({ error: "Not found" }, 404);
    const comments = await listCourseComments(id);
    return c.json({ comments });
  },
);

coursesRoutes.post(
  "/:id/comments",
  requireAuth,
  requireScope("comments:write"),
  coursesWriteLimit,
  zValidator("param", idParam),
  zValidator("json", commentBody),
  async (c) => {
    const userId = c.get("userId") as string;
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const course = await getCourseById(id);
    if (!course) return c.json({ error: "Not found" }, 404);
    const comment = await createCourseComment({
      courseId: id,
      authorId: userId,
      content: body.content,
      parentCommentId: body.parent_comment_id ?? null,
    });
    return c.json({ comment }, 201);
  },
);

coursesRoutes.patch(
  "/comments/:id",
  requireAuth,
  requireScope("comments:write"),
  coursesWriteLimit,
  zValidator("param", idParam),
  zValidator("json", z.object({ content: z.string().trim().min(1).max(10_000) })),
  async (c) => {
    const userId = c.get("userId") as string;
    const { id } = c.req.valid("param");
    const { content } = c.req.valid("json");
    const comment = await updateCourseComment(id, userId, content);
    if (!comment) return c.json({ error: "Not found" }, 404);
    return c.json({ comment });
  },
);

coursesRoutes.delete(
  "/comments/:id",
  requireAuth,
  requireScope("comments:write"),
  coursesWriteLimit,
  zValidator("param", idParam),
  async (c) => {
    const userId = c.get("userId") as string;
    const { id } = c.req.valid("param");
    const removed = await deleteCourseComment(id, userId);
    if (!removed) return c.json({ error: "Not found" }, 404);
    return c.body(null, 204);
  },
);
