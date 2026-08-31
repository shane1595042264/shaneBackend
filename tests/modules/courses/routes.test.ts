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
}

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
