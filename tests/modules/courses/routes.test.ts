// tests/modules/courses/routes.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

const m = vi.hoisted(() => ({
  createCourse: vi.fn(),
  listCourses: vi.fn(),
  getCourseById: vi.fn(),
  getCourseBySlug: vi.fn(),
  getCourseByUrl: vi.fn(),
  slugTaken: vi.fn(),
  updateCourse: vi.fn(),
  deleteCourse: vi.fn(),
  upsertCover: vi.fn(),
  getCover: vi.fn(),
  deleteCoverRow: vi.fn(),
  coverMeta: vi.fn(),
  coverMetaFor: vi.fn(),
  upsertRating: vi.fn(),
  deleteRating: vi.fn(),
  ratingSummaries: vi.fn(),
  ratingSummaryFor: vi.fn(),
  myRatings: vi.fn(),
  myRatingFor: vi.fn(),
  commentCounts: vi.fn(),
  commentCountFor: vi.fn(),
  createCourseComment: vi.fn(),
  listCourseComments: vi.fn(),
  getCourseComment: vi.fn(),
  updateCourseComment: vi.fn(),
  deleteCourseComment: vi.fn(),
  fetchCourseText: vi.fn(),
  classifyCourse: vi.fn(),
  isSiteOwner: vi.fn(),
  getContent: vi.fn(),
  upsertContent: vi.fn(),
  deleteContent: vi.fn(),
  contentMeta: vi.fn(),
  contentMetaFor: vi.fn(),
  listProgress: vi.fn(),
  recordProgress: vi.fn(),
  resetProgress: vi.fn(),
}));

// Literal factory (no importOriginal): pulling the real repo in would load
// @/db/client into the test process.
vi.mock("@/modules/courses/repo", () => {
  return {
    COURSE_CATEGORIES: [
      "math", "physics", "computer-science", "engineering", "biology",
      "chemistry", "history", "economics", "philosophy", "language",
      "art", "music", "other",
    ],
    COURSE_DIFFICULTIES: ["intro", "intermediate", "advanced"],
    COURSE_VISIBILITIES: ["public", "private"],
    isSiteOwner: m.isSiteOwner,
    createCourse: m.createCourse,
    listCourses: m.listCourses,
    getCourseById: m.getCourseById,
    getCourseBySlug: m.getCourseBySlug,
    getCourseByUrl: m.getCourseByUrl,
    slugTaken: m.slugTaken,
    updateCourse: m.updateCourse,
    deleteCourse: m.deleteCourse,
    upsertCover: m.upsertCover,
    getCover: m.getCover,
    deleteCoverRow: m.deleteCoverRow,
    coverMeta: m.coverMeta,
    coverMetaFor: m.coverMetaFor,
    upsertRating: m.upsertRating,
    deleteRating: m.deleteRating,
    ratingSummaries: m.ratingSummaries,
    ratingSummaryFor: m.ratingSummaryFor,
    myRatings: m.myRatings,
    myRatingFor: m.myRatingFor,
    commentCounts: m.commentCounts,
    commentCountFor: m.commentCountFor,
    createCourseComment: m.createCourseComment,
    listCourseComments: m.listCourseComments,
    getCourseComment: m.getCourseComment,
    updateCourseComment: m.updateCourseComment,
    deleteCourseComment: m.deleteCourseComment,
  };
});

vi.mock("@/modules/courses/content-repo", () => ({
  getContent: m.getContent,
  upsertContent: m.upsertContent,
  deleteContent: m.deleteContent,
  contentMeta: m.contentMeta,
  contentMetaFor: m.contentMetaFor,
  listProgress: m.listProgress,
  recordProgress: m.recordProgress,
  resetProgress: m.resetProgress,
}));

// Literal class in the factory: routes.ts instanceof-checks the SAME mocked
// export, so the test's `new CourseFetchError(...)` matches. Importing the
// real classifier would load @/modules/shared/llm (Anthropic client) and
// ./repo (db client) into the test process.
vi.mock("@/modules/courses/classifier", () => {
  class CourseFetchError extends Error {}
  return {
    CourseFetchError,
    fetchCourseText: m.fetchCourseText,
    classifyCourse: m.classifyCourse,
  };
});

vi.mock("@/modules/shared/rate-limit", () => ({
  createPATRateLimit: () => async (_c: unknown, next: () => Promise<void>) => {
    await next();
  },
}));

vi.mock("@/modules/auth/middleware", () => ({
  optionalAuth: async (c: any, next: () => Promise<void>) => {
    c.set("userId", c.req.header("X-Test-User") ?? null);
    c.set("tokenScopes", null);
    await next();
  },
  requireAuth: async (c: any, next: () => Promise<void>) => {
    const u = c.req.header("X-Test-User");
    if (!u) return c.json({ error: "auth" }, 401);
    c.set("userId", u);
    c.set("tokenScopes", null);
    await next();
  },
  requireScope: () => async (_c: unknown, next: () => Promise<void>) => {
    await next();
  },
}));

import { coursesRoutes } from "@/modules/courses/routes";
import { CourseFetchError } from "@/modules/courses/classifier";

const app = new Hono().route("/api/courses", coursesRoutes);

const courseRow = {
  id: "11111111-1111-4111-8111-111111111111",
  userId: "u1",
  slug: "pi2-heist",
  url: "https://x.up.railway.app/courses/pi2-heist/",
  title: "The Pi/2 Heist",
  description: "Contour integration walkthrough.",
  category: "math",
  difficulty: "advanced",
  durationMinutes: 28,
  tags: ["integrals"],
  visibility: "public",
  createdAt: new Date("2026-08-31T00:00:00Z"),
  updatedAt: new Date("2026-08-31T00:00:00Z"),
};

function emptyAggregates() {
  m.coverMeta.mockResolvedValue([]);
  m.coverMetaFor.mockResolvedValue(null);
  m.ratingSummaries.mockResolvedValue([]);
  m.ratingSummaryFor.mockResolvedValue({ average: null, count: 0 });
  m.myRatings.mockResolvedValue([]);
  m.myRatingFor.mockResolvedValue(null);
  m.commentCounts.mockResolvedValue([]);
  m.commentCountFor.mockResolvedValue(0);
  m.isSiteOwner.mockResolvedValue(false);
  m.contentMeta.mockResolvedValue([]);
  m.contentMetaFor.mockResolvedValue(null);
}

const anonymous = { userId: null, isSiteOwner: false };

beforeEach(() => {
  vi.clearAllMocks();
  emptyAggregates();
});

describe("GET /api/courses", () => {
  it("is public and merges aggregates", async () => {
    m.listCourses.mockResolvedValue([courseRow]);
    m.coverMeta.mockResolvedValue([
      { courseId: courseRow.id, updatedAt: new Date("2026-08-31T01:00:00Z") },
    ]);
    m.ratingSummaries.mockResolvedValue([
      { courseId: courseRow.id, average: 4.5, count: 2 },
    ]);
    m.commentCounts.mockResolvedValue([{ courseId: courseRow.id, count: 3 }]);
    const res = await app.request("/api/courses");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.courses).toHaveLength(1);
    const c = body.courses[0];
    expect(c.slug).toBe("pi2-heist");
    expect(c.ownerId).toBe("u1");
    expect(c.rating).toEqual({ average: 4.5, count: 2 });
    expect(c.commentCount).toBe(3);
    expect(c.myStars).toBeNull();
    expect(c.coverUrl).toContain(`/api/courses/covers/${courseRow.id}?v=`);
  });

  it("includes myStars for a signed-in viewer", async () => {
    m.listCourses.mockResolvedValue([courseRow]);
    m.myRatings.mockResolvedValue([{ courseId: courseRow.id, stars: 4 }]);
    const res = await app.request("/api/courses", {
      headers: { "X-Test-User": "viewer" },
    });
    const body = await res.json();
    expect(body.courses[0].myStars).toBe(4);
  });

  it("returns nextCursor null and no paging args when limit is omitted", async () => {
    m.listCourses.mockResolvedValue([courseRow]);
    const res = await app.request("/api/courses");
    const body = await res.json();
    expect(body.nextCursor).toBeNull();
    expect(m.listCourses).toHaveBeenCalledWith({
      limit: undefined,
      cursor: undefined,
      viewer: anonymous,
    });
  });

  it("returns nextCursor from the last row when the page is full", async () => {
    const older = { ...courseRow, id: "c2", createdAt: new Date("2026-08-30T12:00:00Z") };
    m.listCourses.mockResolvedValue([courseRow, older]);
    const res = await app.request("/api/courses?limit=2");
    const body = await res.json();
    expect(body.nextCursor).toBe("2026-08-30T12:00:00.000Z_c2");
    expect(m.listCourses).toHaveBeenCalledWith({ limit: 2, cursor: undefined, viewer: anonymous });
  });

  it("returns nextCursor null on a short final page", async () => {
    m.listCourses.mockResolvedValue([courseRow]);
    const res = await app.request("/api/courses?limit=5");
    expect((await res.json()).nextCursor).toBeNull();
  });

  it("forwards the cursor to the repo", async () => {
    m.listCourses.mockResolvedValue([]);
    const res = await app.request("/api/courses?limit=2&cursor=2026-08-31T00:00:00.000Z");
    expect(res.status).toBe(200);
    expect(m.listCourses).toHaveBeenCalledWith({
      limit: 2,
      cursor: "2026-08-31T00:00:00.000Z",
      viewer: anonymous,
    });
  });

  it("400s on a bad limit or a malformed cursor", async () => {
    expect((await app.request("/api/courses?limit=abc")).status).toBe(400);
    expect((await app.request("/api/courses?limit=0")).status).toBe(400);
    expect((await app.request("/api/courses?limit=101")).status).toBe(400);
    expect((await app.request("/api/courses?cursor=nope")).status).toBe(400);
  });

  it("scopes the aggregates to the ids on the page", async () => {
    m.listCourses.mockResolvedValue([courseRow]);
    await app.request("/api/courses?limit=1", { headers: { "X-Test-User": "viewer" } });
    expect(m.coverMeta).toHaveBeenCalledWith([courseRow.id]);
    expect(m.ratingSummaries).toHaveBeenCalledWith([courseRow.id]);
    expect(m.commentCounts).toHaveBeenCalledWith([courseRow.id]);
    expect(m.myRatings).toHaveBeenCalledWith("viewer", [courseRow.id]);
  });
});

describe("GET /api/courses/:slug", () => {
  it("404s on a missing slug", async () => {
    m.getCourseBySlug.mockResolvedValue(null);
    const res = await app.request("/api/courses/nope");
    expect(res.status).toBe(404);
  });
  it("returns the course with aggregates", async () => {
    m.getCourseBySlug.mockResolvedValue(courseRow);
    m.ratingSummaryFor.mockResolvedValue({ average: 5, count: 1 });
    m.commentCountFor.mockResolvedValue(2);
    const res = await app.request("/api/courses/pi2-heist");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.course.rating).toEqual({ average: 5, count: 1 });
    expect(body.course.commentCount).toBe(2);
    expect(body.course.coverUrl).toBeNull();
  });
});

describe("GET /api/courses/covers/:courseId", () => {
  it("serves stored bytes with immutable caching", async () => {
    m.getCover.mockResolvedValue({
      mimeType: "image/png",
      byteSize: 3,
      data: Buffer.from([1, 2, 3]),
    });
    const res = await app.request(`/api/courses/covers/${courseRow.id}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
    expect(res.headers.get("Cache-Control")).toContain("immutable");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });
  it("404s when absent", async () => {
    m.getCover.mockResolvedValue(null);
    const res = await app.request(`/api/courses/covers/${courseRow.id}`);
    expect(res.status).toBe(404);
  });
});

describe("POST /api/courses", () => {
  const goodBody = { url: "https://x.up.railway.app/courses/pi2-heist/" };
  const classification = {
    title: "The Pi/2 Heist",
    description: "Contour integration walkthrough.",
    category: "math",
    difficulty: "advanced",
    durationMinutes: 28,
    tags: ["integrals"],
  };

  it("401s signed out", async () => {
    const res = await app.request("/api/courses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(goodBody),
    });
    expect(res.status).toBe(401);
  });

  // SHAN-582: Bun's fetch reads file:// URLs, so a non-http scheme must never
  // reach fetchCourseText.
  it.each(["file:///proc/self/environ", "javascript:alert(1)", "data:text/html,hi", "ftp://x.test/c"])(
    "400s a non-http url (%s) without fetching it",
    async (url) => {
      const res = await app.request("/api/courses", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Test-User": "u1" },
        body: JSON.stringify({ url }),
      });
      expect(res.status).toBe(400);
      expect(m.fetchCourseText).not.toHaveBeenCalled();
    },
  );

  it("400s a PATCH to a non-http url", async () => {
    const res = await app.request(`/api/courses/${courseRow.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "X-Test-User": "u1" },
      body: JSON.stringify({ url: "javascript:alert(1)" }),
    });
    expect(res.status).toBe(400);
    expect(m.updateCourse).not.toHaveBeenCalled();
  });

  it("409s on a duplicate url", async () => {
    m.getCourseByUrl.mockResolvedValue(courseRow);
    const res = await app.request("/api/courses", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Test-User": "u1" },
      body: JSON.stringify(goodBody),
    });
    expect(res.status).toBe(409);
  });

  it("502s when the course page cannot be fetched", async () => {
    m.getCourseByUrl.mockResolvedValue(null);
    m.fetchCourseText.mockRejectedValue(new CourseFetchError("Could not reach the course page"));
    const res = await app.request("/api/courses", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Test-User": "u1" },
      body: JSON.stringify(goodBody),
    });
    expect(res.status).toBe(502);
  });

  it("classifies, slugs, and creates", async () => {
    m.getCourseByUrl.mockResolvedValue(null);
    m.fetchCourseText.mockResolvedValue("page text");
    m.classifyCourse.mockResolvedValue(classification);
    m.slugTaken.mockResolvedValue(false);
    m.createCourse.mockResolvedValue(courseRow);
    const res = await app.request("/api/courses", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Test-User": "u1" },
      body: JSON.stringify(goodBody),
    });
    expect(res.status).toBe(201);
    expect(m.createCourse.mock.calls[0][0]).toMatchObject({
      userId: "u1",
      title: "The Pi/2 Heist",
      category: "math",
    });
    const body = await res.json();
    expect(body.course.slug).toBe("pi2-heist");
  });

  it("prefers an explicit title over the AI title", async () => {
    m.getCourseByUrl.mockResolvedValue(null);
    m.fetchCourseText.mockResolvedValue("page text");
    m.classifyCourse.mockResolvedValue(classification);
    m.slugTaken.mockResolvedValue(false);
    m.createCourse.mockResolvedValue(courseRow);
    await app.request("/api/courses", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Test-User": "u1" },
      body: JSON.stringify({ ...goodBody, title: "My Custom Title" }),
    });
    expect(m.createCourse.mock.calls[0][0]).toMatchObject({ title: "My Custom Title" });
  });

  it("defaults visibility to public and accepts private (SHAN-617)", async () => {
    m.getCourseByUrl.mockResolvedValue(null);
    m.fetchCourseText.mockResolvedValue("page text");
    m.classifyCourse.mockResolvedValue(classification);
    m.slugTaken.mockResolvedValue(false);
    m.createCourse.mockImplementation(async (input) => ({ ...courseRow, ...input }));
    const post = (body: object) =>
      app.request("/api/courses", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Test-User": "u1" },
        body: JSON.stringify(body),
      });
    await post(goodBody);
    expect(m.createCourse.mock.calls[0][0]).toMatchObject({ visibility: "public" });
    const res = await post({ ...goodBody, visibility: "private" });
    expect(res.status).toBe(201);
    expect(m.createCourse.mock.calls[1][0]).toMatchObject({ visibility: "private" });
    expect((await res.json()).course.visibility).toBe("private");
  });

  it("never mints a slug the site reserves under /courses/", async () => {
    m.getCourseByUrl.mockResolvedValue(null);
    m.fetchCourseText.mockResolvedValue("page text");
    m.classifyCourse.mockResolvedValue({ ...classification, title: "Private" });
    m.slugTaken.mockResolvedValue(false);
    m.createCourse.mockImplementation(async (input) => ({ ...courseRow, ...input }));
    await app.request("/api/courses", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Test-User": "u1" },
      body: JSON.stringify(goodBody),
    });
    const { slug } = m.createCourse.mock.calls[0][0];
    expect(slug).not.toBe("private");
    expect(slug).toMatch(/^private-[a-z0-9]{4}$/);
  });

  it("400s an unknown visibility before fetching anything", async () => {
    const res = await app.request("/api/courses", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Test-User": "u1" },
      body: JSON.stringify({ ...goodBody, visibility: "secret" }),
    });
    expect(res.status).toBe(400);
    expect(m.fetchCourseText).not.toHaveBeenCalled();
  });
});

describe("private courses (SHAN-617)", () => {
  const privateRow = { ...courseRow, visibility: "private" };

  it("lists with the caller as the viewer, and the owner flag from isSiteOwner", async () => {
    m.listCourses.mockResolvedValue([]);
    await app.request("/api/courses", { headers: { "X-Test-User": "u1" } });
    expect(m.listCourses).toHaveBeenLastCalledWith({
      limit: undefined,
      cursor: undefined,
      viewer: { userId: "u1", isSiteOwner: false },
    });
    m.isSiteOwner.mockResolvedValue(true);
    await app.request("/api/courses", { headers: { "X-Test-User": "shane" } });
    expect(m.isSiteOwner).toHaveBeenLastCalledWith("shane");
    expect(m.listCourses).toHaveBeenLastCalledWith({
      limit: undefined,
      cursor: undefined,
      viewer: { userId: "shane", isSiteOwner: true },
    });
  });

  it("does not look up the owner for an anonymous list", async () => {
    m.listCourses.mockResolvedValue([]);
    await app.request("/api/courses");
    expect(m.isSiteOwner).not.toHaveBeenCalled();
  });

  it("404s the slug for anonymous and for another user", async () => {
    m.getCourseBySlug.mockResolvedValue(privateRow);
    expect((await app.request("/api/courses/pi2-heist")).status).toBe(404);
    const res = await app.request("/api/courses/pi2-heist", {
      headers: { "X-Test-User": "stranger" },
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Not found" });
  });

  it("serves the slug to its creator and to the site owner", async () => {
    m.getCourseBySlug.mockResolvedValue(privateRow);
    const mine = await app.request("/api/courses/pi2-heist", {
      headers: { "X-Test-User": "u1" },
    });
    expect(mine.status).toBe(200);
    expect((await mine.json()).course.visibility).toBe("private");
    expect(m.isSiteOwner).not.toHaveBeenCalled();
    m.isSiteOwner.mockResolvedValue(true);
    const owner = await app.request("/api/courses/pi2-heist", {
      headers: { "X-Test-User": "shane" },
    });
    expect(owner.status).toBe(200);
  });

  it("404s comments, rating and commenting for a stranger without writing", async () => {
    m.getCourseById.mockResolvedValue(privateRow);
    const h = { "Content-Type": "application/json", "X-Test-User": "stranger" };
    const base = `/api/courses/${courseRow.id}`;
    expect((await app.request(`${base}/comments`)).status).toBe(404);
    expect(
      (await app.request(`${base}/comments`, {
        method: "POST",
        headers: h,
        body: JSON.stringify({ content: "hi" }),
      })).status,
    ).toBe(404);
    expect(
      (await app.request(`${base}/rating`, {
        method: "PUT",
        headers: h,
        body: JSON.stringify({ stars: 5 }),
      })).status,
    ).toBe(404);
    expect((await app.request(`${base}/rating`, { method: "DELETE", headers: h })).status).toBe(
      404,
    );
    expect(m.listCourseComments).not.toHaveBeenCalled();
    expect(m.createCourseComment).not.toHaveBeenCalled();
    expect(m.upsertRating).not.toHaveBeenCalled();
    expect(m.deleteRating).not.toHaveBeenCalled();
  });

  it("lets the creator rate and comment on their private course", async () => {
    m.getCourseById.mockResolvedValue(privateRow);
    m.createCourseComment.mockResolvedValue({ id: "c" });
    const h = { "Content-Type": "application/json", "X-Test-User": "u1" };
    const base = `/api/courses/${courseRow.id}`;
    const rated = await app.request(`${base}/rating`, {
      method: "PUT",
      headers: h,
      body: JSON.stringify({ stars: 4 }),
    });
    expect(rated.status).toBe(200);
    const commented = await app.request(`${base}/comments`, {
      method: "POST",
      headers: h,
      body: JSON.stringify({ content: "note to self" }),
    });
    expect(commented.status).toBe(201);
  });

  it("PATCH accepts visibility on its own and rejects an unknown one", async () => {
    m.updateCourse.mockResolvedValue(privateRow);
    const patch = (body: object) =>
      app.request(`/api/courses/${courseRow.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "X-Test-User": "u1" },
        body: JSON.stringify(body),
      });
    const ok = await patch({ visibility: "private" });
    expect(ok.status).toBe(200);
    expect(m.updateCourse).toHaveBeenCalledWith(courseRow.id, "u1", { visibility: "private" });
    expect((await patch({ visibility: "hidden" })).status).toBe(400);
  });
});

describe("PATCH /api/courses/:id", () => {
  it("404s for a non-owner (repo returns null)", async () => {
    m.getCourseById.mockResolvedValue(courseRow);
    m.updateCourse.mockResolvedValue(null);
    const res = await app.request(`/api/courses/${courseRow.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "X-Test-User": "intruder" },
      body: JSON.stringify({ title: "Hijacked" }),
    });
    expect(res.status).toBe(404);
  });
  it("409s when changing url to an existing one", async () => {
    m.getCourseByUrl.mockResolvedValue({ ...courseRow, id: "other-id" });
    const res = await app.request(`/api/courses/${courseRow.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "X-Test-User": "u1" },
      body: JSON.stringify({ url: "https://x/dupe" }),
    });
    expect(res.status).toBe(409);
  });
  it("updates and returns the course", async () => {
    m.updateCourse.mockResolvedValue({ ...courseRow, title: "New" });
    const res = await app.request(`/api/courses/${courseRow.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "X-Test-User": "u1" },
      body: JSON.stringify({ title: "New" }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).course.title).toBe("New");
  });
});

describe("POST /api/courses/:id/reclassify", () => {
  it("re-runs the classifier and preserves title", async () => {
    m.getCourseById.mockResolvedValue(courseRow);
    m.fetchCourseText.mockResolvedValue("fresh text");
    m.classifyCourse.mockResolvedValue({
      title: "Ignored New Title",
      description: "Updated summary.",
      category: "physics",
      difficulty: "intro",
      durationMinutes: 12,
      tags: ["waves"],
    });
    m.updateCourse.mockResolvedValue({ ...courseRow, category: "physics" });
    const res = await app.request(`/api/courses/${courseRow.id}/reclassify`, {
      method: "POST",
      headers: { "X-Test-User": "u1" },
    });
    expect(res.status).toBe(200);
    const patch = m.updateCourse.mock.calls[0][2];
    expect(patch.category).toBe("physics");
    expect(patch).not.toHaveProperty("title");
  });
  it("404s when the caller is not the owner", async () => {
    m.getCourseById.mockResolvedValue(courseRow);
    const res = await app.request(`/api/courses/${courseRow.id}/reclassify`, {
      method: "POST",
      headers: { "X-Test-User": "intruder" },
    });
    expect(res.status).toBe(404);
  });
});

describe("DELETE /api/courses/:id", () => {
  it("204s on success", async () => {
    m.deleteCourse.mockResolvedValue(true);
    const res = await app.request(`/api/courses/${courseRow.id}`, {
      method: "DELETE",
      headers: { "X-Test-User": "u1" },
    });
    expect(res.status).toBe(204);
  });
  it("404s when nothing was deleted", async () => {
    m.deleteCourse.mockResolvedValue(false);
    const res = await app.request(`/api/courses/${courseRow.id}`, {
      method: "DELETE",
      headers: { "X-Test-User": "intruder" },
    });
    expect(res.status).toBe(404);
  });
});

describe("PUT /api/courses/:id/cover", () => {
  function multipart(file: File) {
    const form = new FormData();
    form.append("file", file);
    return form;
  }
  const PNG_MAGIC = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]);

  it("400s on non-multipart", async () => {
    m.getCourseById.mockResolvedValue(courseRow);
    const res = await app.request(`/api/courses/${courseRow.id}/cover`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "X-Test-User": "u1" },
      body: "{}",
    });
    expect(res.status).toBe(400);
  });

  it("413s an oversized file", async () => {
    m.getCourseById.mockResolvedValue(courseRow);
    const big = new File([new Uint8Array(5 * 1024 * 1024 + 1)], "big.png", { type: "image/png" });
    const res = await app.request(`/api/courses/${courseRow.id}/cover`, {
      method: "PUT",
      headers: { "X-Test-User": "u1" },
      body: multipart(big),
    });
    expect(res.status).toBe(413);
  });

  it("415s an unsniffable file", async () => {
    m.getCourseById.mockResolvedValue(courseRow);
    const txt = new File([new TextEncoder().encode("plain text")], "x.png", { type: "image/png" });
    const res = await app.request(`/api/courses/${courseRow.id}/cover`, {
      method: "PUT",
      headers: { "X-Test-User": "u1" },
      body: multipart(txt),
    });
    expect(res.status).toBe(415);
  });

  it("stores a real png and returns a cache-busted coverUrl", async () => {
    m.getCourseById.mockResolvedValue(courseRow);
    m.upsertCover.mockResolvedValue(undefined);
    const png = new File([PNG_MAGIC], "cover.png", { type: "image/png" });
    const res = await app.request(`/api/courses/${courseRow.id}/cover`, {
      method: "PUT",
      headers: { "X-Test-User": "u1" },
      body: multipart(png),
    });
    expect(res.status).toBe(200);
    expect(m.upsertCover).toHaveBeenCalledWith(
      courseRow.id,
      "image/png",
      expect.any(Buffer),
    );
    expect((await res.json()).coverUrl).toContain(`/api/courses/covers/${courseRow.id}?v=`);
  });

  it("404s for a non-owner", async () => {
    m.getCourseById.mockResolvedValue(courseRow);
    const png = new File([PNG_MAGIC], "cover.png", { type: "image/png" });
    const res = await app.request(`/api/courses/${courseRow.id}/cover`, {
      method: "PUT",
      headers: { "X-Test-User": "intruder" },
      body: multipart(png),
    });
    expect(res.status).toBe(404);
  });
});

describe("DELETE /api/courses/:id/cover", () => {
  it("204s and deletes the cover row", async () => {
    m.getCourseById.mockResolvedValue(courseRow);
    const res = await app.request(`/api/courses/${courseRow.id}/cover`, {
      method: "DELETE",
      headers: { "X-Test-User": "u1" },
    });
    expect(res.status).toBe(204);
    expect(m.deleteCoverRow).toHaveBeenCalledWith(courseRow.id);
  });
});

describe("PUT /api/courses/:id/rating", () => {
  it("401s signed out", async () => {
    const res = await app.request(`/api/courses/${courseRow.id}/rating`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stars: 5 }),
    });
    expect(res.status).toBe(401);
  });
  it("400s out-of-range stars", async () => {
    m.getCourseById.mockResolvedValue(courseRow);
    const res = await app.request(`/api/courses/${courseRow.id}/rating`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "X-Test-User": "viewer" },
      body: JSON.stringify({ stars: 6 }),
    });
    expect(res.status).toBe(400);
  });
  it("404s an unknown course", async () => {
    m.getCourseById.mockResolvedValue(null);
    const res = await app.request(`/api/courses/${courseRow.id}/rating`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "X-Test-User": "viewer" },
      body: JSON.stringify({ stars: 5 }),
    });
    expect(res.status).toBe(404);
  });
  it("upserts and returns the fresh aggregate", async () => {
    m.getCourseById.mockResolvedValue(courseRow);
    m.ratingSummaryFor.mockResolvedValue({ average: 4.5, count: 2 });
    const res = await app.request(`/api/courses/${courseRow.id}/rating`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "X-Test-User": "viewer" },
      body: JSON.stringify({ stars: 5 }),
    });
    expect(res.status).toBe(200);
    expect(m.upsertRating).toHaveBeenCalledWith(courseRow.id, "viewer", 5);
    expect(await res.json()).toEqual({ rating: { average: 4.5, count: 2, mine: 5 } });
  });
});

describe("DELETE /api/courses/:id/rating", () => {
  it("removes the caller's rating and returns the aggregate", async () => {
    m.getCourseById.mockResolvedValue(courseRow);
    m.ratingSummaryFor.mockResolvedValue({ average: null, count: 0 });
    const res = await app.request(`/api/courses/${courseRow.id}/rating`, {
      method: "DELETE",
      headers: { "X-Test-User": "viewer" },
    });
    expect(res.status).toBe(200);
    expect(m.deleteRating).toHaveBeenCalledWith(courseRow.id, "viewer");
    expect(await res.json()).toEqual({ rating: { average: null, count: 0, mine: null } });
  });
});

describe("course comments", () => {
  const comment = {
    id: "22222222-2222-4222-8222-222222222222",
    courseId: courseRow.id,
    parentCommentId: null,
    authorId: "viewer",
    author: { id: "viewer", name: "Ava", avatarUrl: null },
    content: "Great lecture",
    editedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  it("GET lists publicly", async () => {
    m.getCourseById.mockResolvedValue(courseRow);
    m.listCourseComments.mockResolvedValue([comment]);
    const res = await app.request(`/api/courses/${courseRow.id}/comments`);
    expect(res.status).toBe(200);
    expect((await res.json()).comments).toHaveLength(1);
  });

  it("POST 401s signed out", async () => {
    const res = await app.request(`/api/courses/${courseRow.id}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "hi" }),
    });
    expect(res.status).toBe(401);
  });

  it("POST creates with parent_comment_id", async () => {
    m.getCourseById.mockResolvedValue(courseRow);
    m.getCourseComment.mockResolvedValue(comment);
    m.createCourseComment.mockResolvedValue(comment);
    const res = await app.request(`/api/courses/${courseRow.id}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Test-User": "viewer" },
      body: JSON.stringify({ content: "Great lecture", parent_comment_id: comment.id }),
    });
    expect(res.status).toBe(201);
    expect(m.createCourseComment).toHaveBeenCalledWith({
      courseId: courseRow.id,
      authorId: "viewer",
      content: "Great lecture",
      parentCommentId: comment.id,
    });
  });

  it.each([
    ["does not exist", null],
    ["is on another course", { courseId: "99999999-9999-4999-8999-999999999999", parentCommentId: null }],
    ["is itself a reply", { courseId: courseRow.id, parentCommentId: "33333333-3333-4333-8333-333333333333" }],
  ])("POST 400s when the parent %s (SHAN-574)", async (_label, parent) => {
    m.getCourseById.mockResolvedValue(courseRow);
    m.getCourseComment.mockResolvedValue(parent && { ...comment, ...parent });
    const res = await app.request(`/api/courses/${courseRow.id}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Test-User": "viewer" },
      body: JSON.stringify({ content: "reply", parent_comment_id: comment.id }),
    });
    expect(res.status).toBe(400);
    expect(m.createCourseComment).not.toHaveBeenCalled();
  });

  it("POST 404s for an unknown course", async () => {
    m.getCourseById.mockResolvedValue(null);
    const res = await app.request(`/api/courses/${courseRow.id}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Test-User": "viewer" },
      body: JSON.stringify({ content: "hi" }),
    });
    expect(res.status).toBe(404);
  });

  it("PATCH edits only the author's comment", async () => {
    m.updateCourseComment.mockResolvedValue(null);
    const res = await app.request(`/api/courses/comments/${comment.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "X-Test-User": "stranger" },
      body: JSON.stringify({ content: "edited" }),
    });
    expect(res.status).toBe(404);
  });

  it("DELETE 204s for author or course owner", async () => {
    m.deleteCourseComment.mockResolvedValue(true);
    const res = await app.request(`/api/courses/comments/${comment.id}`, {
      method: "DELETE",
      headers: { "X-Test-User": "u1" },
    });
    expect(res.status).toBe(204);
  });

  it("DELETE 404s otherwise", async () => {
    m.deleteCourseComment.mockResolvedValue(false);
    const res = await app.request(`/api/courses/comments/${comment.id}`, {
      method: "DELETE",
      headers: { "X-Test-User": "stranger" },
    });
    expect(res.status).toBe(404);
  });
});

// ---- Interactive lessons ---------------------------------------------------

const lessonDoc = {
  units: [
    {
      title: "The trip",
      lessons: [
        {
          id: "ten-stops",
          title: "Ten stops",
          steps: [
            { type: "teach", body: "A page view makes ten stops." },
            {
              type: "choice",
              prompt: "Where does the pixel send a hit?",
              choices: [{ text: "The collector", correct: true }, { text: "BigQuery" }],
            },
          ],
        },
      ],
    },
  ],
};

function req(path: string, method: string, body?: unknown, user: string | null = "u1") {
  return app.request(path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(user ? { "X-Test-User": user } : {}),
    },
    ...(body !== undefined ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}),
  });
}

describe("POST /api/courses with lesson content", () => {
  it("creates a lessons-only course without fetching or classifying anything", async () => {
    m.slugTaken.mockResolvedValue(false);
    m.createCourse.mockImplementation(async (input: Record<string, unknown>) => ({
      ...courseRow,
      ...input,
      id: courseRow.id,
    }));
    m.upsertContent.mockResolvedValue({ updatedAt: new Date() });
    const res = await req("/api/courses", "POST", {
      title: "Where Dealer Visitors Go",
      visibility: "private",
      content: lessonDoc,
    });
    expect(res.status).toBe(201);
    expect(m.fetchCourseText).not.toHaveBeenCalled();
    expect(m.classifyCourse).not.toHaveBeenCalled();
    const created = m.createCourse.mock.calls[0][0];
    expect(created.url).toBeNull();
    expect(created.title).toBe("Where Dealer Visitors Go");
    expect(created.category).toBe("other");
    expect(created.durationMinutes).toBe(1);
    expect(created.visibility).toBe("private");
    const [courseId, content, stats] = m.upsertContent.mock.calls[0];
    expect(courseId).toBe(courseRow.id);
    expect(content.units[0].id).toBe("the-trip");
    expect(stats).toMatchObject({ lessons: 1, steps: 2, exercises: 1 });
    const body = await res.json();
    expect(body.course.lessonCount).toBe(1);
    expect(body.course.stepCount).toBe(2);
    expect(body.course.url).toBeNull();
  });

  it("400s invalid content with pathed issues and writes nothing", async () => {
    const res = await req("/api/courses", "POST", {
      title: "Broken",
      content: { units: [{ title: "U", lessons: [{ title: "L", steps: [{ type: "teach", body: "only reading" }] }] }] },
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.issues[0].path).toBe("units[0].lessons[0].steps");
    expect(m.createCourse).not.toHaveBeenCalled();
  });

  it("400s a lessons-only course without a title", async () => {
    const res = await req("/api/courses", "POST", { content: lessonDoc });
    expect(res.status).toBe(400);
    expect(m.createCourse).not.toHaveBeenCalled();
  });

  it("400s a body with neither url nor content", async () => {
    const res = await req("/api/courses", "POST", { title: "Nothing" });
    expect(res.status).toBe(400);
  });
});

describe("POST /api/courses/content/validate", () => {
  it("401s signed out", async () => {
    const res = await req("/api/courses/content/validate", "POST", lessonDoc, null);
    expect(res.status).toBe(401);
  });

  it("returns the normalised document and stats", async () => {
    const res = await req("/api/courses/content/validate", "POST", lessonDoc);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.content.version).toBe(1);
    expect(body.content.units[0].lessons[0].id).toBe("ten-stops");
    expect(body.stats.exercises).toBe(1);
  });

  it("answers 200 with issues for a wrong document", async () => {
    const res = await req("/api/courses/content/validate", "POST", { units: [] });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.issues[0]).toEqual({ path: "units", message: "A course needs at least one unit" });
  });

  it("reports a body that is not JSON", async () => {
    const res = await req("/api/courses/content/validate", "POST", "{nope");
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.issues[0].message).toBe("Body is not valid JSON");
  });
});

describe("GET /api/courses/:id/content", () => {
  it("serves the document of a public course to anyone", async () => {
    m.getCourseById.mockResolvedValue(courseRow);
    m.getContent.mockResolvedValue({
      content: { version: 1, ...lessonDoc },
      lessonCount: 1,
      stepCount: 2,
      updatedAt: new Date("2026-11-03T00:00:00Z"),
    });
    const res = await req(`/api/courses/${courseRow.id}/content`, "GET", undefined, null);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.stats.lessons).toBe(1);
  });

  it("404s a private course to a stranger, the same as a missing one", async () => {
    m.getCourseById.mockResolvedValue({ ...courseRow, visibility: "private" });
    const res = await req(`/api/courses/${courseRow.id}/content`, "GET", undefined, "stranger");
    expect(res.status).toBe(404);
    expect(m.getContent).not.toHaveBeenCalled();
  });

  it("404s a deck-only course", async () => {
    m.getCourseById.mockResolvedValue(courseRow);
    m.getContent.mockResolvedValue(null);
    const res = await req(`/api/courses/${courseRow.id}/content`, "GET");
    expect(res.status).toBe(404);
  });
});

describe("PUT /api/courses/:id/content", () => {
  beforeEach(() => {
    m.upsertContent.mockResolvedValue({ updatedAt: new Date() });
    m.updateCourse.mockImplementation(async () => courseRow);
  });

  it("lets only the course owner write", async () => {
    m.getCourseById.mockResolvedValue(courseRow);
    const res = await req(`/api/courses/${courseRow.id}/content`, "PUT", lessonDoc, "someone-else");
    expect(res.status).toBe(404);
    expect(m.upsertContent).not.toHaveBeenCalled();
  });

  it("stores the normalised document and leaves a deck's duration alone", async () => {
    m.getCourseById.mockResolvedValue(courseRow);
    const res = await req(`/api/courses/${courseRow.id}/content`, "PUT", lessonDoc);
    expect(res.status).toBe(200);
    expect(m.upsertContent).toHaveBeenCalledTimes(1);
    expect(m.updateCourse.mock.calls[0][2]).toEqual({});
    const body = await res.json();
    expect(body.content.units[0].id).toBe("the-trip");
  });

  it("syncs a lessons-only course's duration to the lessons", async () => {
    m.getCourseById.mockResolvedValue({ ...courseRow, url: null });
    await req(`/api/courses/${courseRow.id}/content`, "PUT", lessonDoc);
    expect(m.updateCourse.mock.calls[0][2]).toEqual({ durationMinutes: 1 });
  });

  it("400s an invalid document with issues", async () => {
    m.getCourseById.mockResolvedValue(courseRow);
    const res = await req(`/api/courses/${courseRow.id}/content`, "PUT", {
      units: [{ title: "U", lessons: [{ title: "L", steps: [{ type: "choice", prompt: "?", choices: [{ text: "a" }, { text: "b" }] }] }] }],
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.issues[0].path).toBe("units[0].lessons[0].steps[0].choices");
    expect(m.upsertContent).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/courses/:id/content", () => {
  it("refuses to strip the lessons off a lessons-only course", async () => {
    m.getCourseById.mockResolvedValue({ ...courseRow, url: null });
    const res = await req(`/api/courses/${courseRow.id}/content`, "DELETE");
    expect(res.status).toBe(400);
    expect(m.deleteContent).not.toHaveBeenCalled();
  });

  it("removes the lessons from a deck course", async () => {
    m.getCourseById.mockResolvedValue(courseRow);
    m.deleteContent.mockResolvedValue(true);
    const res = await req(`/api/courses/${courseRow.id}/content`, "DELETE");
    expect(res.status).toBe(204);
  });
});

describe("PATCH /api/courses/:id url: null", () => {
  it("400s removing the deck URL from a course without lessons", async () => {
    m.contentMetaFor.mockResolvedValue(null);
    const res = await req(`/api/courses/${courseRow.id}`, "PATCH", { url: null });
    expect(res.status).toBe(400);
    expect(m.updateCourse).not.toHaveBeenCalled();
  });

  it("allows it once the course has lessons", async () => {
    m.contentMetaFor.mockResolvedValue({ lessonCount: 3, stepCount: 20 });
    m.updateCourse.mockResolvedValue({ ...courseRow, url: null });
    const res = await req(`/api/courses/${courseRow.id}`, "PATCH", { url: null });
    expect(res.status).toBe(200);
    expect((await res.json()).course.lessonCount).toBe(3);
  });
});

describe("POST /api/courses/:id/reclassify on a lessons-only course", () => {
  it("400s instead of fetching a null url", async () => {
    m.getCourseById.mockResolvedValue({ ...courseRow, url: null });
    const res = await req(`/api/courses/${courseRow.id}/reclassify`, "POST");
    expect(res.status).toBe(400);
    expect(m.fetchCourseText).not.toHaveBeenCalled();
  });
});

describe("course progress", () => {
  const stored = {
    content: { version: 1, ...lessonDoc },
    lessonCount: 1,
    stepCount: 2,
    updatedAt: new Date(),
  };
  const progressRow = {
    lessonId: "ten-stops",
    bestScore: 100,
    lastScore: 100,
    attempts: 1,
    completedAt: new Date("2026-11-03T00:00:00Z"),
    updatedAt: new Date("2026-11-03T00:00:00Z"),
  };

  it("401s signed out", async () => {
    const res = await req(`/api/courses/${courseRow.id}/progress`, "GET", undefined, null);
    expect(res.status).toBe(401);
  });

  it("lists the learner's own progress", async () => {
    m.getCourseById.mockResolvedValue(courseRow);
    m.listProgress.mockResolvedValue([progressRow]);
    const res = await req(`/api/courses/${courseRow.id}/progress`, "GET", undefined, "learner");
    expect(res.status).toBe(200);
    expect(m.listProgress).toHaveBeenCalledWith("learner", courseRow.id);
    expect((await res.json()).progress[0].lessonId).toBe("ten-stops");
  });

  it("records a finished lesson", async () => {
    m.getCourseById.mockResolvedValue(courseRow);
    m.getContent.mockResolvedValue(stored);
    m.recordProgress.mockResolvedValue(progressRow);
    const res = await req(`/api/courses/${courseRow.id}/progress/ten-stops`, "PUT", { score: 100 }, "learner");
    expect(res.status).toBe(200);
    expect(m.recordProgress).toHaveBeenCalledWith("learner", courseRow.id, "ten-stops", 100);
  });

  it("404s a lesson id the course does not have", async () => {
    m.getCourseById.mockResolvedValue(courseRow);
    m.getContent.mockResolvedValue(stored);
    const res = await req(`/api/courses/${courseRow.id}/progress/nope`, "PUT", { score: 50 }, "learner");
    expect(res.status).toBe(404);
    expect(m.recordProgress).not.toHaveBeenCalled();
  });

  it("400s a score outside 0-100", async () => {
    const res = await req(`/api/courses/${courseRow.id}/progress/ten-stops`, "PUT", { score: 101 }, "learner");
    expect(res.status).toBe(400);
  });

  it("404s progress on a private course the learner cannot see", async () => {
    m.getCourseById.mockResolvedValue({ ...courseRow, visibility: "private" });
    const res = await req(`/api/courses/${courseRow.id}/progress/ten-stops`, "PUT", { score: 50 }, "stranger");
    expect(res.status).toBe(404);
  });

  it("resets the learner's progress", async () => {
    m.getCourseById.mockResolvedValue(courseRow);
    const res = await req(`/api/courses/${courseRow.id}/progress`, "DELETE", undefined, "learner");
    expect(res.status).toBe(204);
    expect(m.resetProgress).toHaveBeenCalledWith("learner", courseRow.id);
  });
});
