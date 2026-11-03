// src/modules/courses/routes.ts
import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@/modules/shared/zod-validator";
import { optionalAuth, requireAuth, requireScope } from "@/modules/auth/middleware";
import { createPATRateLimit } from "@/modules/shared/rate-limit";
import { sniffImageMime } from "@/modules/shared/image-validate";
import { httpUrlSchema } from "@/modules/shared/outbound-url";
import {
  trimmedNullish,
  trimmedOptional,
  trimmedLabels,
  uuidId,
} from "@/modules/shared/validators";
import { generateUniqueSlug } from "@/modules/trips/slug";
import { CourseFetchError, classifyCourse, fetchCourseText } from "./classifier";
import {
  COURSE_CATEGORIES,
  COURSE_DIFFICULTIES,
  COURSE_VISIBILITIES,
  type CourseRow,
  type CourseViewer,
  isSiteOwner,
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
  getCourseComment,
  listCourseComments,
  updateCourseComment,
  deleteCourseComment,
} from "./repo";
import { encodeKeysetCursor, keysetCursorParam } from "@/modules/shared/keyset";
import {
  MAX_CONTENT_BYTES,
  contentStats,
  findLesson,
  validateCourseContent,
  type ContentIssue,
} from "./content-schema";
import {
  contentMeta,
  contentMetaFor,
  deleteContent,
  getContent,
  listProgress,
  recordProgress,
  resetProgress,
  upsertContent,
} from "./content-repo";

// Per-PAT 60s rolling write limit. JWT browser sessions bypass. Distinct
// bucket so a busy courses session doesn't lock out other modules.
const coursesWriteLimit = createPATRateLimit({
  bucket: "courses-write",
  limitPerMinute: 60,
});

type Vars = { Variables: { userId: string | null; tokenScopes: string[] | null } };
export const coursesRoutes = new Hono<Vars>();

const COVER_MAX_BYTES = 5 * 1024 * 1024;

const idParam = z.object({ id: uuidId() });
const courseIdParam = z.object({ courseId: uuidId() });
const slugParam = z.object({ slug: z.string().trim().min(1).max(80) });
// http(s) only: a bare .url() let file:///proc/self/environ through to the
// classifier fetch (SHAN-582).
const urlSchema = httpUrlSchema;

// Two ways to make a course. With `url`, the deck is fetched and classified
// (the original flow). With `content` and no `url`, it is an interactive
// course built from the structured lesson format: nothing is fetched and no
// model is called, so `title` is required and the rest of the metadata comes
// from the request. Both together = a deck plus lessons. Explicit metadata
// always wins over the classifier's guess.
const createBody = z
  .object({
    url: urlSchema.optional(),
    title: trimmedOptional(200),
    description: trimmedNullish(2000),
    category: z.enum(COURSE_CATEGORIES).optional(),
    difficulty: z.enum(COURSE_DIFFICULTIES).optional(),
    durationMinutes: z.number().int().min(1).max(100_000).nullish(),
    tags: trimmedLabels(40, 8),
    visibility: z.enum(COURSE_VISIBILITIES).default("public"),
    content: z.unknown().optional(),
  })
  .refine((b) => b.url !== undefined || b.content !== undefined, {
    message: "Send a deck `url`, lesson `content`, or both",
  })
  .refine((b) => b.url !== undefined || b.title !== undefined, {
    message: "A course without a deck URL needs a `title`",
    path: ["title"],
  });

const lessonParam = z.object({
  id: uuidId(),
  lessonId: z.string().trim().min(1).max(64),
});

const progressBody = z.object({ score: z.number().int().min(0).max(100) });

function contentInvalid(issues: ContentIssue[]) {
  return { error: "Course content is invalid", issues };
}

const patchBody = z
  .object({
    title: trimmedOptional(200),
    description: trimmedNullish(2000),
    category: z.enum(COURSE_CATEGORIES).optional(),
    difficulty: z.enum(COURSE_DIFFICULTIES).optional(),
    durationMinutes: z.number().int().min(1).max(100_000).nullish(),
    tags: trimmedLabels(40, 8),
    // null removes the deck link, allowed only while the course has lessons.
    url: urlSchema.nullable().optional(),
    visibility: z.enum(COURSE_VISIBILITIES).optional(),
  })
  .refine(
    (b) =>
      b.title !== undefined ||
      b.description !== undefined ||
      b.category !== undefined ||
      b.difficulty !== undefined ||
      b.durationMinutes !== undefined ||
      b.tags !== undefined ||
      b.url !== undefined ||
      b.visibility !== undefined,
    { message: "At least one field is required" },
  );

// Same shape as trips: `limit` is optional (omitting it returns the whole
// catalog, which is what the site did before pagination existed) and `cursor`
// is the compound keyset cursor (`<iso>_<id>`) that nextCursor emits — see
// modules/shared/keyset.ts. Validating the shape here means a malformed cursor
// is a 400 rather than a silent page 1; bare ISO cursors minted before
// SHAN-513 still parse.
const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: keysetCursorParam.optional(),
});

const ratingBody = z.object({ stars: z.number().int().min(1).max(5) });

const commentBody = z.object({
  content: z.string().trim().min(1).max(10_000),
  parent_comment_id: uuidId().optional(),
});

interface CourseMeta {
  coverUpdatedAt: Date | null;
  lessonCount: number;
  stepCount: number;
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
    visibility: row.visibility,
    ownerId: row.userId,
    coverUrl: coverUrlFor(row.id, meta.coverUpdatedAt),
    rating: { average: meta.average, count: meta.count },
    commentCount: meta.commentCount,
    myStars: meta.myStars,
    // 0 = a deck-only course. Anything else is played on shanejli.com.
    lessonCount: meta.lessonCount,
    stepCount: meta.stepCount,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

const EMPTY_META: CourseMeta = {
  coverUpdatedAt: null,
  lessonCount: 0,
  stepCount: 0,
  average: null,
  count: 0,
  commentCount: 0,
  myStars: null,
};

async function metaFor(courseId: string, userId: string | null): Promise<CourseMeta> {
  const [cover, rating, comments, mine, lessons] = await Promise.all([
    coverMetaFor(courseId),
    ratingSummaryFor(courseId),
    commentCountFor(courseId),
    userId ? myRatingFor(courseId, userId) : Promise.resolve(null),
    contentMetaFor(courseId),
  ]);
  return {
    coverUpdatedAt: cover?.updatedAt ?? null,
    lessonCount: lessons?.lessonCount ?? 0,
    stepCount: lessons?.stepCount ?? 0,
    average: rating.average,
    count: rating.count,
    commentCount: comments,
    myStars: mine,
  };
}

// Segments under shanejli.com/courses/ that are not course slugs: the site's
// middleware 404s them without probing (SHAN-460), and /courses/private/<slug>
// is where private courses are read (SHAN-617). A course minted with one of
// these slugs would be unreachable, so the generator treats them as taken.
const RESERVED_SLUGS = new Set(["covers", "private"]);

async function courseSlugTaken(slug: string): Promise<boolean> {
  return RESERVED_SLUGS.has(slug) || slugTaken(slug);
}

// ---- Private courses (SHAN-617) ------------------------------------------

async function viewerFor(userId: string | null): Promise<CourseViewer> {
  return { userId, isSiteOwner: userId ? await isSiteOwner(userId) : false };
}

/**
 * A private course is readable only by its creator and the site owner. Every
 * route that takes a course id or slug answers anyone else with the same 404
 * as a missing course, so a private course cannot be confirmed to exist.
 */
async function canSee(row: CourseRow, userId: string | null): Promise<boolean> {
  if (row.visibility !== "private") return true;
  if (!userId) return false;
  return row.userId === userId || (await isSiteOwner(userId));
}

// ---- Public reads --------------------------------------------------------

// Cover bytes. No auth: uuid-addressed and <img> cannot send Authorization.
// Immutable cache is safe because the URL carries ?v=<updatedAt>. This stays
// open for private courses too: the course id only ever reaches someone who
// can see the course, so the URL works as a capability.
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

coursesRoutes.get("/", optionalAuth, zValidator("query", listQuery), async (c) => {
  const userId = c.get("userId");
  const { limit, cursor } = c.req.valid("query");
  // Fetch the page first, then scope every aggregate to the ids on it, so a
  // request costs what the page costs instead of scanning the whole catalog
  // (plus covers, ratings and comments) on every load.
  const rows = await listCourses({ limit, cursor, viewer: await viewerFor(userId) });
  const ids = rows.map((r) => r.id);
  const [covers, ratings, comments, mine, lessons] = await Promise.all([
    coverMeta(ids),
    ratingSummaries(ids),
    commentCounts(ids),
    userId ? myRatings(userId, ids) : Promise.resolve([]),
    contentMeta(ids),
  ]);
  const lessonsBy = new Map(lessons.map((r) => [r.courseId, r]));
  const coverBy = new Map(covers.map((r) => [r.courseId, r.updatedAt]));
  const ratingBy = new Map(ratings.map((r) => [r.courseId, r]));
  const commentBy = new Map(comments.map((r) => [r.courseId, r.count]));
  const mineBy = new Map(mine.map((r) => [r.courseId, r.stars]));
  const last = rows[rows.length - 1];
  const nextCursor =
    limit && rows.length === limit ? encodeKeysetCursor(last.createdAt, last.id) : null;
  return c.json({
    courses: rows.map((row) =>
      serializeCourse(row, {
        coverUpdatedAt: coverBy.get(row.id) ?? null,
        lessonCount: lessonsBy.get(row.id)?.lessonCount ?? 0,
        stepCount: lessonsBy.get(row.id)?.stepCount ?? 0,
        average: ratingBy.get(row.id)?.average ?? null,
        count: ratingBy.get(row.id)?.count ?? 0,
        commentCount: commentBy.get(row.id) ?? 0,
        myStars: mineBy.get(row.id) ?? null,
      }),
    ),
    nextCursor,
  });
});

coursesRoutes.get(
  "/:slug",
  optionalAuth,
  zValidator("param", slugParam),
  async (c) => {
    const { slug } = c.req.valid("param");
    const row = await getCourseBySlug(slug);
    if (!row || !(await canSee(row, c.get("userId")))) {
      return c.json({ error: "Not found" }, 404);
    }
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
    // Validate lessons before anything is written, so a bad document never
    // leaves a half-made course behind.
    let lessons: Extract<ReturnType<typeof validateCourseContent>, { ok: true }> | null = null;
    if (body.content !== undefined) {
      const result = validateCourseContent(body.content);
      if (!result.ok) return c.json(contentInvalid(result.issues), 400);
      lessons = result;
    }

    let meta: {
      title: string;
      description: string | null;
      category: (typeof COURSE_CATEGORIES)[number];
      difficulty: (typeof COURSE_DIFFICULTIES)[number];
      durationMinutes: number | null;
      tags: string[];
    };
    if (body.url !== undefined) {
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
      meta = {
        title: body.title ?? ai.title,
        description: body.description !== undefined ? body.description : ai.description,
        category: body.category ?? ai.category,
        difficulty: body.difficulty ?? ai.difficulty,
        durationMinutes:
          body.durationMinutes !== undefined ? body.durationMinutes : ai.durationMinutes,
        tags: body.tags ?? ai.tags,
      };
    } else {
      meta = {
        title: body.title as string,
        description: body.description ?? null,
        category: body.category ?? "other",
        difficulty: body.difficulty ?? "intro",
        durationMinutes: body.durationMinutes ?? lessons?.stats.estimatedMinutes ?? null,
        tags: body.tags ?? [],
      };
    }

    const slug = await generateUniqueSlug(meta.title, courseSlugTaken);
    const row = await createCourse({
      userId,
      slug,
      url: body.url ?? null,
      ...meta,
      visibility: body.visibility,
    });
    if (lessons) await upsertContent(row.id, lessons.content, lessons.stats);
    return c.json(
      {
        course: serializeCourse(row, {
          ...EMPTY_META,
          lessonCount: lessons?.stats.lessons ?? 0,
          stepCount: lessons?.stats.steps ?? 0,
        }),
      },
      201,
    );
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
    if (body.url) {
      const clash = await getCourseByUrl(body.url);
      if (clash && clash.id !== id) {
        return c.json({ error: "A course with this URL already exists" }, 409);
      }
    }
    if (body.url === null && !(await contentMetaFor(id))) {
      return c.json(
        { error: "A course needs a deck URL or lessons; add lessons before removing the URL" },
        400,
      );
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
    if (!course.url) {
      return c.json({ error: "This course has no deck URL to classify" }, 400);
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

// ---- Interactive lessons --------------------------------------------------

async function readJsonBody(
  c: { req: { header: (n: string) => string | undefined; json: () => Promise<unknown> } },
): Promise<{ ok: true; body: unknown } | { ok: false; tooLarge: boolean }> {
  const size = Number(c.req.header("Content-Length") ?? 0);
  if (size > MAX_CONTENT_BYTES * 2) return { ok: false, tooLarge: true };
  try {
    return { ok: true, body: await c.req.json() };
  } catch {
    return { ok: false, tooLarge: false };
  }
}

// Dry run for the lesson editor and API callers: the normalised document (ids
// filled in) and its stats, or every issue with a path. Always 200 so the
// editor can tell "your document is wrong" from "the request failed".
coursesRoutes.post("/content/validate", requireAuth, async (c) => {
  const read = await readJsonBody(c);
  if (!read.ok) {
    if (read.tooLarge) return c.json({ error: "Document too large (limit 512 KB)" }, 413);
    return c.json({ ok: false, issues: [{ path: "", message: "Body is not valid JSON" }] });
  }
  const result = validateCourseContent(read.body);
  return c.json(result.ok ? { ok: true, content: result.content, stats: result.stats } : result);
});

coursesRoutes.get(
  "/:id/content",
  optionalAuth,
  zValidator("param", idParam),
  async (c) => {
    const { id } = c.req.valid("param");
    const course = await getCourseById(id);
    if (!course || !(await canSee(course, c.get("userId")))) {
      return c.json({ error: "Not found" }, 404);
    }
    const row = await getContent(id);
    if (!row) return c.json({ error: "This course has no lessons" }, 404);
    return c.json({
      content: row.content,
      stats: contentStats(row.content),
      updatedAt: row.updatedAt,
    });
  },
);

// Replace the whole lesson document. The body IS the document (the same JSON
// the editor shows), so `curl -X PUT --data @course.json` is the whole upload.
coursesRoutes.put(
  "/:id/content",
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
    const read = await readJsonBody(c);
    if (!read.ok) {
      if (read.tooLarge) return c.json({ error: "Document too large (limit 512 KB)" }, 413);
      return c.json(contentInvalid([{ path: "", message: "Body is not valid JSON" }]), 400);
    }
    const result = validateCourseContent(read.body);
    if (!result.ok) return c.json(contentInvalid(result.issues), 400);
    const saved = await upsertContent(id, result.content, result.stats);
    // A lessons-only course has no deck to estimate from, so its length is
    // whatever the lessons add up to. A deck's own estimate is left alone.
    const row = await updateCourse(
      id,
      userId,
      course.url ? {} : { durationMinutes: result.stats.estimatedMinutes },
    );
    const meta = await metaFor(id, userId);
    return c.json({
      content: result.content,
      stats: result.stats,
      updatedAt: saved.updatedAt,
      course: serializeCourse(row ?? course, meta),
    });
  },
);

coursesRoutes.delete(
  "/:id/content",
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
    if (!course.url) {
      return c.json(
        { error: "This course is lessons only; delete the course instead of its lessons" },
        400,
      );
    }
    const removed = await deleteContent(id);
    if (!removed) return c.json({ error: "This course has no lessons" }, 404);
    return c.body(null, 204);
  },
);

// ---- Progress (any signed-in learner) -------------------------------------

function serializeProgress(p: {
  lessonId: string;
  bestScore: number;
  lastScore: number;
  attempts: number;
  completedAt: Date;
  updatedAt: Date;
}) {
  return {
    lessonId: p.lessonId,
    bestScore: p.bestScore,
    lastScore: p.lastScore,
    attempts: p.attempts,
    completedAt: p.completedAt,
    updatedAt: p.updatedAt,
  };
}

coursesRoutes.get(
  "/:id/progress",
  requireAuth,
  zValidator("param", idParam),
  async (c) => {
    const userId = c.get("userId") as string;
    const { id } = c.req.valid("param");
    const course = await getCourseById(id);
    if (!course || !(await canSee(course, userId))) {
      return c.json({ error: "Not found" }, 404);
    }
    const rows = await listProgress(userId, id);
    return c.json({ progress: rows.map(serializeProgress) });
  },
);

coursesRoutes.put(
  "/:id/progress/:lessonId",
  requireAuth,
  requireScope("reactions:write"),
  coursesWriteLimit,
  zValidator("param", lessonParam),
  zValidator("json", progressBody),
  async (c) => {
    const userId = c.get("userId") as string;
    const { id, lessonId } = c.req.valid("param");
    const { score } = c.req.valid("json");
    const course = await getCourseById(id);
    if (!course || !(await canSee(course, userId))) {
      return c.json({ error: "Not found" }, 404);
    }
    const row = await getContent(id);
    if (!row || !findLesson(row.content, lessonId)) {
      return c.json({ error: "No such lesson in this course" }, 404);
    }
    const saved = await recordProgress(userId, id, lessonId, score);
    return c.json({ progress: serializeProgress(saved) });
  },
);

coursesRoutes.delete(
  "/:id/progress",
  requireAuth,
  requireScope("reactions:write"),
  coursesWriteLimit,
  zValidator("param", idParam),
  async (c) => {
    const userId = c.get("userId") as string;
    const { id } = c.req.valid("param");
    const course = await getCourseById(id);
    if (!course || !(await canSee(course, userId))) {
      return c.json({ error: "Not found" }, 404);
    }
    await resetProgress(userId, id);
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
    if (!course || !(await canSee(course, userId))) {
      return c.json({ error: "Not found" }, 404);
    }
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
    if (!course || !(await canSee(course, userId))) {
      return c.json({ error: "Not found" }, 404);
    }
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
    if (!course || !(await canSee(course, c.get("userId")))) {
      return c.json({ error: "Not found" }, 404);
    }
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
    if (!course || !(await canSee(course, userId))) {
      return c.json({ error: "Not found" }, 404);
    }
    // SHAN-574: only a top-level comment on this course can take a reply.
    if (body.parent_comment_id) {
      const parent = await getCourseComment(body.parent_comment_id);
      if (!parent || parent.courseId !== id || parent.parentCommentId !== null) {
        return c.json({ error: "parent_comment_id must be a top-level comment on this course" }, 400);
      }
    }
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
