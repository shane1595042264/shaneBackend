// tests/modules/blog/routes.test.ts — SHAN-478 Phase 1
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

const {
  mockCreatePost,
  mockGetPostBySlug,
  mockListPosts,
  mockSlugTaken,
  mockSoftDeletePost,
  mockUpdatePostMeta,
  mockAppendVersion,
  mockGetVersion,
  mockListVersions,
  mockRevert,
} = vi.hoisted(() => ({
  mockCreatePost: vi.fn(),
  mockGetPostBySlug: vi.fn(),
  mockListPosts: vi.fn(),
  mockSlugTaken: vi.fn().mockResolvedValue(false),
  mockSoftDeletePost: vi.fn(),
  mockUpdatePostMeta: vi.fn(),
  mockAppendVersion: vi.fn(),
  mockGetVersion: vi.fn(),
  mockListVersions: vi.fn(),
  mockRevert: vi.fn(),
}));

vi.mock("@/modules/blog/posts-repo", () => ({
  createPost: mockCreatePost,
  getPostBySlug: mockGetPostBySlug,
  listPosts: mockListPosts,
  slugTaken: mockSlugTaken,
  softDeletePost: mockSoftDeletePost,
  updatePostMeta: mockUpdatePostMeta,
  hashContent: (s: string) => "hash-" + s.length,
}));

// VersionConflictError has to be the real class: routes.ts branches on
// `err instanceof VersionConflictError`, so a stub would fall through to a 500.
vi.mock("@/modules/blog/versions-repo", async () => {
  class VersionConflictError extends Error {
    constructor(public currentVersionNum: number) {
      super("VersionConflict");
      this.name = "VersionConflict";
    }
  }
  return {
    appendDirectVersion: mockAppendVersion,
    getVersion: mockGetVersion,
    listVersions: mockListVersions,
    revertToVersion: mockRevert,
    VersionConflictError,
  };
});

vi.mock("@/modules/auth/user-prefs", () => ({
  getUserTimezone: vi.fn().mockResolvedValue("America/Chicago"),
  DEFAULT_TIMEZONE: "America/Chicago",
}));

vi.mock("@/modules/auth/middleware", () => ({
  optionalAuth: async (c: any, next: any) => {
    c.set("userId", c.req.header("X-Test-User") ?? null);
    c.set("tokenScopes", null);
    await next();
  },
  requireAuth: async (c: any, next: any) => {
    const u = c.req.header("X-Test-User");
    if (!u) return c.json({ error: "auth" }, 401);
    c.set("userId", u);
    c.set("tokenScopes", null);
    await next();
  },
  requireScope: () => async (_c: any, next: any) => { await next(); },
}));

import { blogRoutes } from "@/modules/blog/routes";
import { VersionConflictError } from "@/modules/blog/versions-repo";

beforeEach(() => {
  vi.clearAllMocks();
  mockSlugTaken.mockResolvedValue(false);
});

const app = new Hono().route("/api/blog", blogRoutes);

const publishedAt = new Date("2026-09-01T12:00:00.000Z");
const postRow = (over: Record<string, unknown> = {}) => ({
  post: {
    id: "p1",
    slug: "hello-world",
    title: "Hello World",
    authorId: "u1",
    status: "published",
    ...over,
  },
  currentVersion: { versionNum: 3, title: "Hello World", content: "body" },
  author: { id: "u1", name: "Shane", avatarUrl: null },
});

describe("GET /api/blog/posts", () => {
  it("is readable with no Authorization header at all", async () => {
    mockListPosts.mockResolvedValue([]);
    const res = await app.request("/api/blog/posts");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ posts: [], nextCursor: null });
  });

  it("emits a publishedAt cursor when the page is full", async () => {
    mockListPosts.mockResolvedValue([
      { id: "p1", publishedAt: new Date("2026-09-02T00:00:00.000Z") },
      { id: "p2", publishedAt },
    ]);
    const res = await app.request("/api/blog/posts?limit=2");
    const body = await res.json();
    expect(body.nextCursor).toBe("2026-09-01T12:00:00.000Z");
  });

  it("returns a null cursor when the page is short", async () => {
    mockListPosts.mockResolvedValue([{ id: "p1", publishedAt }]);
    const res = await app.request("/api/blog/posts?limit=20");
    expect((await res.json()).nextCursor).toBeNull();
  });

  it("forwards tag, q and cursor to the repo", async () => {
    mockListPosts.mockResolvedValue([]);
    await app.request("/api/blog/posts?tag=rust&q=borrow&cursor=2026-09-01T12:00:00.000Z&limit=5");
    expect(mockListPosts).toHaveBeenCalledWith(
      expect.objectContaining({ tag: "rust", q: "borrow", limit: 5, cursorPublishedAt: publishedAt })
    );
  });

  it("400s on a cursor that is not a datetime", async () => {
    const res = await app.request("/api/blog/posts?cursor=2026-09-01");
    expect(res.status).toBe(400);
    expect(mockListPosts).not.toHaveBeenCalled();
  });

  it("passes no viewer id for anonymous callers, so drafts stay hidden", async () => {
    mockListPosts.mockResolvedValue([]);
    await app.request("/api/blog/posts");
    expect(mockListPosts).toHaveBeenCalledWith(
      expect.objectContaining({ includeDraftsForAuthorId: null })
    );
  });

  it("passes the signed-in user so they see their own drafts", async () => {
    mockListPosts.mockResolvedValue([]);
    await app.request("/api/blog/posts", { headers: { "X-Test-User": "u1" } });
    expect(mockListPosts).toHaveBeenCalledWith(
      expect.objectContaining({ includeDraftsForAuthorId: "u1" })
    );
  });
});

describe("GET /api/blog/posts/:slug", () => {
  it("returns the post body and current version number to an anonymous reader", async () => {
    mockGetPostBySlug.mockResolvedValue(postRow());
    const res = await app.request("/api/blog/posts/hello-world");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.content).toBe("body");
    expect(body.currentVersionNum).toBe(3);
    expect(body.author.name).toBe("Shane");
  });

  it("404s for an unknown slug", async () => {
    mockGetPostBySlug.mockResolvedValue(null);
    expect((await app.request("/api/blog/posts/nope")).status).toBe(404);
  });

  it("400s on a malformed slug before it reaches the repo", async () => {
    const res = await app.request("/api/blog/posts/Not%20A%20Slug");
    expect(res.status).toBe(400);
    expect(mockGetPostBySlug).not.toHaveBeenCalled();
  });
});

describe("GET /api/blog/posts/:slug/versions", () => {
  it("paginates on versionNum", async () => {
    mockGetPostBySlug.mockResolvedValue(postRow());
    mockListVersions.mockResolvedValue([{ versionNum: 3 }, { versionNum: 2 }]);
    const res = await app.request("/api/blog/posts/hello-world/versions?limit=2");
    expect((await res.json()).nextCursor).toBe(2);
  });

  it("404s when the post is missing", async () => {
    mockGetPostBySlug.mockResolvedValue(null);
    expect((await app.request("/api/blog/posts/nope/versions")).status).toBe(404);
  });

  it("404s on a version number the post does not have", async () => {
    mockGetPostBySlug.mockResolvedValue(postRow());
    mockGetVersion.mockResolvedValue(null);
    expect((await app.request("/api/blog/posts/hello-world/versions/99")).status).toBe(404);
  });
});

describe("POST /api/blog/posts", () => {
  it("401s without auth", async () => {
    const res = await app.request("/api/blog/posts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "T", content: "c" }),
    });
    expect(res.status).toBe(401);
  });

  it("creates a post with a slug generated from the title", async () => {
    mockCreatePost.mockResolvedValue({ post: { id: "p1", slug: "hello-world" }, version: { versionNum: 1 } });
    const res = await app.request("/api/blog/posts", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Test-User": "u1" },
      body: JSON.stringify({ title: "Hello World", content: "body", tags: ["rust"] }),
    });
    expect(res.status).toBe(201);
    expect(mockCreatePost).toHaveBeenCalledWith(
      expect.objectContaining({ slug: "hello-world", title: "Hello World", authorId: "u1", tags: ["rust"] })
    );
    expect((await res.json()).currentVersionNum).toBe(1);
  });

  it("defaults status to published", async () => {
    mockCreatePost.mockResolvedValue({ post: {}, version: { versionNum: 1 } });
    await app.request("/api/blog/posts", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Test-User": "u1" },
      body: JSON.stringify({ title: "T", content: "c" }),
    });
    expect(mockCreatePost).toHaveBeenCalledWith(expect.objectContaining({ status: "published" }));
  });

  it("400s on a whitespace-only body", async () => {
    const res = await app.request("/api/blog/posts", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Test-User": "u1" },
      body: JSON.stringify({ title: "T", content: "   " }),
    });
    expect(res.status).toBe(400);
    expect(mockCreatePost).not.toHaveBeenCalled();
  });

  it("400s when the body still references an in-flight image upload", async () => {
    const res = await app.request("/api/blog/posts", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Test-User": "u1" },
      body: JSON.stringify({ title: "T", content: "![](uploading-abc123)" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("PATCH /api/blog/posts/:slug", () => {
  const patch = (body: unknown, headers: Record<string, string> = {}) =>
    app.request("/api/blog/posts/hello-world", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "X-Test-User": "u1", ...headers },
      body: JSON.stringify(body),
    });

  it("400s when the patch is empty", async () => {
    const res = await patch({});
    expect(res.status).toBe(400);
    expect(mockGetPostBySlug).not.toHaveBeenCalled();
  });

  it("403s when the caller is not the author", async () => {
    mockGetPostBySlug.mockResolvedValue(postRow({ authorId: "someone-else" }));
    const res = await patch({ tags: ["x"] });
    expect(res.status).toBe(403);
  });

  it("428s on a body edit with no If-Match header", async () => {
    mockGetPostBySlug.mockResolvedValue(postRow());
    const res = await patch({ content: "new body" });
    expect(res.status).toBe(428);
    expect(mockAppendVersion).not.toHaveBeenCalled();
  });

  it("mints a new version for a body edit", async () => {
    mockGetPostBySlug.mockResolvedValue(postRow());
    mockAppendVersion.mockResolvedValue({ versionNum: 4, id: "v4" });
    const res = await patch({ content: "new body" }, { "If-Match": "3" });
    expect(res.status).toBe(200);
    expect((await res.json()).currentVersionNum).toBe(4);
    expect(mockAppendVersion).toHaveBeenCalledWith(
      expect.objectContaining({ postId: "p1", content: "new body", ifMatchVersionNum: 3 })
    );
  });

  it("carries the existing title forward when only the body changes", async () => {
    mockGetPostBySlug.mockResolvedValue(postRow());
    mockAppendVersion.mockResolvedValue({ versionNum: 4, id: "v4" });
    await patch({ content: "new body" }, { "If-Match": "3" });
    expect(mockAppendVersion).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Hello World" })
    );
  });

  it("carries the existing body forward when only the title changes", async () => {
    mockGetPostBySlug.mockResolvedValue(postRow());
    mockAppendVersion.mockResolvedValue({ versionNum: 4, id: "v4" });
    await patch({ title: "Renamed" }, { "If-Match": "3" });
    expect(mockAppendVersion).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Renamed", content: "body" })
    );
  });

  it("409s with the current version on a stale If-Match", async () => {
    mockGetPostBySlug.mockResolvedValue(postRow());
    mockAppendVersion.mockRejectedValue(new VersionConflictError(7));
    const res = await patch({ content: "new body" }, { "If-Match": "3" });
    expect(res.status).toBe(409);
    expect((await res.json()).currentVersionNum).toBe(7);
  });

  it("updates tags without minting a version or demanding If-Match", async () => {
    mockGetPostBySlug.mockResolvedValue(postRow());
    mockUpdatePostMeta.mockResolvedValue({ id: "p1", tags: ["rust"] });
    const res = await patch({ tags: ["rust"] });
    expect(res.status).toBe(200);
    expect(mockAppendVersion).not.toHaveBeenCalled();
    expect(mockUpdatePostMeta).toHaveBeenCalledWith("hello-world", "u1", {
      tags: ["rust"],
      status: undefined,
    });
  });

  it("404s for an unknown slug", async () => {
    mockGetPostBySlug.mockResolvedValue(null);
    expect((await patch({ tags: [] })).status).toBe(404);
  });
});

describe("POST /api/blog/posts/:slug/revert", () => {
  const revert = (body: unknown, headers: Record<string, string> = {}) =>
    app.request("/api/blog/posts/hello-world/revert", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Test-User": "u1", ...headers },
      body: JSON.stringify(body),
    });

  it("428s without If-Match", async () => {
    const res = await revert({ target_version_num: 1 });
    expect(res.status).toBe(428);
  });

  it("400s on a non-numeric If-Match", async () => {
    const res = await revert({ target_version_num: 1 }, { "If-Match": "abc" });
    expect(res.status).toBe(400);
  });

  it("403s when the caller is not the author", async () => {
    mockGetPostBySlug.mockResolvedValue(postRow({ authorId: "u2" }));
    const res = await revert({ target_version_num: 1 }, { "If-Match": "3" });
    expect(res.status).toBe(403);
  });

  it("returns the new version number on success", async () => {
    mockGetPostBySlug.mockResolvedValue(postRow());
    mockRevert.mockResolvedValue({ versionNum: 4, id: "v4" });
    const res = await revert({ target_version_num: 1 }, { "If-Match": "3" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ versionNum: 4, versionId: "v4" });
  });

  it("404s rather than 500s when the target version does not exist", async () => {
    mockGetPostBySlug.mockResolvedValue(postRow());
    mockRevert.mockRejectedValue(new Error("Target version not found"));
    const res = await revert({ target_version_num: 99 }, { "If-Match": "3" });
    expect(res.status).toBe(404);
  });

  it("409s on a stale If-Match", async () => {
    mockGetPostBySlug.mockResolvedValue(postRow());
    mockRevert.mockRejectedValue(new VersionConflictError(9));
    const res = await revert({ target_version_num: 1 }, { "If-Match": "3" });
    expect(res.status).toBe(409);
  });
});

describe("DELETE /api/blog/posts/:slug", () => {
  it("401s without auth", async () => {
    const res = await app.request("/api/blog/posts/hello-world", { method: "DELETE" });
    expect(res.status).toBe(401);
  });

  it("204s when the author's post was trashed", async () => {
    mockSoftDeletePost.mockResolvedValue(true);
    const res = await app.request("/api/blog/posts/hello-world", {
      method: "DELETE",
      headers: { "X-Test-User": "u1" },
    });
    expect(res.status).toBe(204);
    expect(mockSoftDeletePost).toHaveBeenCalledWith("hello-world", "u1");
  });

  it("404s when the slug is missing or owned by someone else", async () => {
    mockSoftDeletePost.mockResolvedValue(false);
    const res = await app.request("/api/blog/posts/hello-world", {
      method: "DELETE",
      headers: { "X-Test-User": "u2" },
    });
    expect(res.status).toBe(404);
  });
});

describe("POST /api/blog/posts slug collisions", () => {
  const create = () =>
    app.request("/api/blog/posts", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Test-User": "u1" },
      body: JSON.stringify({ title: "Hello World", content: "body" }),
    });

  it("retries once with a fresh slug when the insert races another create", async () => {
    const clash = Object.assign(new Error("duplicate key"), { code: "23505" });
    mockCreatePost
      .mockRejectedValueOnce(clash)
      .mockResolvedValueOnce({ post: { id: "p1" }, version: { versionNum: 1 } });
    // Second probe sees the row the racing request committed.
    mockSlugTaken.mockResolvedValueOnce(false).mockResolvedValue(true);

    const res = await create();
    expect(res.status).toBe(201);
    expect(mockCreatePost).toHaveBeenCalledTimes(2);
    expect(mockCreatePost.mock.calls[1][0].slug).not.toBe("hello-world");
  });

  it("gives up after one retry instead of looping forever", async () => {
    const clash = Object.assign(new Error("duplicate key"), { code: "23505" });
    mockCreatePost.mockRejectedValue(clash);
    const res = await create();
    expect(res.status).toBe(500);
    expect(mockCreatePost).toHaveBeenCalledTimes(2);
  });

  it("does not retry on an unrelated failure", async () => {
    mockCreatePost.mockRejectedValue(new Error("boom"));
    const res = await create();
    expect(res.status).toBe(500);
    expect(mockCreatePost).toHaveBeenCalledTimes(1);
  });
});

describe("PATCH /api/blog/posts/:slug response freshness", () => {
  const patch = (body: unknown, headers: Record<string, string> = {}) =>
    app.request("/api/blog/posts/hello-world", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "X-Test-User": "u1", ...headers },
      body: JSON.stringify(body),
    });

  it("re-reads the post after a body-only edit so the title is not a pre-edit snapshot", async () => {
    // First read is the pre-edit row the handler loads to authorize; the
    // second is the refetch that must supply the response.
    mockGetPostBySlug
      .mockResolvedValueOnce(postRow())
      .mockResolvedValueOnce(postRow({ title: "Renamed", editCount: 2 }));
    mockAppendVersion.mockResolvedValue({ versionNum: 4, id: "v4" });

    const res = await patch({ title: "Renamed" }, { "If-Match": "3" });
    const body = await res.json();
    expect(body.post.title).toBe("Renamed");
    expect(body.post.editCount).toBe(2);
    expect(mockGetPostBySlug).toHaveBeenCalledTimes(2);
  });

  it("does not spend an extra read when the patch also updates metadata", async () => {
    mockGetPostBySlug.mockResolvedValue(postRow());
    mockAppendVersion.mockResolvedValue({ versionNum: 4, id: "v4" });
    // updatePostMeta runs after the append, so its RETURNING row is already fresh.
    mockUpdatePostMeta.mockResolvedValue({ id: "p1", title: "Renamed", editCount: 2 });

    const res = await patch({ title: "Renamed", tags: ["x"] }, { "If-Match": "3" });
    expect((await res.json()).post.title).toBe("Renamed");
    expect(mockGetPostBySlug).toHaveBeenCalledTimes(1);
  });

  it("does not re-read for a metadata-only patch", async () => {
    mockGetPostBySlug.mockResolvedValue(postRow());
    mockUpdatePostMeta.mockResolvedValue({ id: "p1", tags: ["x"] });
    await patch({ tags: ["x"] });
    expect(mockGetPostBySlug).toHaveBeenCalledTimes(1);
  });
});

// SHAN-487: cover images. Metadata, so a cover-only PATCH must never touch the
// version chain, and the validator has to keep a cover from pointing anywhere
// other than an uploaded image or an https URL.
describe("cover_image_url", () => {
  const COVER = "/api/journal/images/11111111-2222-3333-4444-555555555555";

  const patch = (body: unknown, headers: Record<string, string> = {}) =>
    app.request("/api/blog/posts/hello-world", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "X-Test-User": "u1", ...headers },
      body: JSON.stringify(body),
    });

  it("passes an uploaded image path through on create", async () => {
    mockCreatePost.mockResolvedValue({ post: {}, version: { versionNum: 1 } });
    const res = await app.request("/api/blog/posts", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Test-User": "u1" },
      body: JSON.stringify({ title: "T", content: "c", cover_image_url: COVER }),
    });
    expect(res.status).toBe(201);
    expect(mockCreatePost).toHaveBeenCalledWith(
      expect.objectContaining({ coverImageUrl: COVER })
    );
  });

  it("stores null when no cover is supplied on create", async () => {
    mockCreatePost.mockResolvedValue({ post: {}, version: { versionNum: 1 } });
    await app.request("/api/blog/posts", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Test-User": "u1" },
      body: JSON.stringify({ title: "T", content: "c" }),
    });
    expect(mockCreatePost).toHaveBeenCalledWith(
      expect.objectContaining({ coverImageUrl: null })
    );
  });

  it("accepts an absolute https URL", async () => {
    mockCreatePost.mockResolvedValue({ post: {}, version: { versionNum: 1 } });
    const res = await app.request("/api/blog/posts", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Test-User": "u1" },
      body: JSON.stringify({
        title: "T",
        content: "c",
        cover_image_url: "https://images.example.com/a.jpg",
      }),
    });
    expect(res.status).toBe(201);
  });

  it.each([
    ["javascript:alert(1)"],
    ["http://images.example.com/a.jpg"],
    ["/api/admin/secrets"],
    ["/api/journal/images/not-a-uuid"],
  ])("400s on %s", async (bad) => {
    const res = await app.request("/api/blog/posts", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Test-User": "u1" },
      body: JSON.stringify({ title: "T", content: "c", cover_image_url: bad }),
    });
    expect(res.status).toBe(400);
    expect(mockCreatePost).not.toHaveBeenCalled();
  });

  it("treats a cover-only patch as a real patch, not an empty one", async () => {
    mockGetPostBySlug.mockResolvedValue(postRow());
    mockUpdatePostMeta.mockResolvedValue({ id: "p1", coverImageUrl: COVER });
    const res = await patch({ cover_image_url: COVER });
    expect(res.status).toBe(200);
    expect(mockUpdatePostMeta).toHaveBeenCalledWith(
      "hello-world",
      "u1",
      expect.objectContaining({ coverImageUrl: COVER })
    );
  });

  it("does not mint a version for a cover-only patch", async () => {
    mockGetPostBySlug.mockResolvedValue(postRow());
    mockUpdatePostMeta.mockResolvedValue({ id: "p1", coverImageUrl: COVER });
    await patch({ cover_image_url: COVER });
    expect(mockAppendVersion).not.toHaveBeenCalled();
  });

  it("clears the cover on an explicit null", async () => {
    mockGetPostBySlug.mockResolvedValue(postRow());
    mockUpdatePostMeta.mockResolvedValue({ id: "p1", coverImageUrl: null });
    await patch({ cover_image_url: null });
    expect(mockUpdatePostMeta).toHaveBeenCalledWith(
      "hello-world",
      "u1",
      expect.objectContaining({ coverImageUrl: null })
    );
  });

  it("leaves the cover alone when the field is omitted", async () => {
    mockGetPostBySlug.mockResolvedValue(postRow());
    mockUpdatePostMeta.mockResolvedValue({ id: "p1" });
    await patch({ tags: ["x"] });
    expect(mockUpdatePostMeta).toHaveBeenCalledWith(
      "hello-world",
      "u1",
      expect.objectContaining({ coverImageUrl: undefined })
    );
  });

  it("collapses a blank cover string to null rather than persisting empty text", async () => {
    mockGetPostBySlug.mockResolvedValue(postRow());
    mockUpdatePostMeta.mockResolvedValue({ id: "p1", coverImageUrl: null });
    await patch({ cover_image_url: "   " });
    expect(mockUpdatePostMeta).toHaveBeenCalledWith(
      "hello-world",
      "u1",
      expect.objectContaining({ coverImageUrl: null })
    );
  });
});

// SHAN-487: X-If-Match is the proxy-safe alias for If-Match. A real If-Match
// never survives the Vercel rewrite — the edge compares it against our weak
// ETag, fails the strong-comparison rule and answers 412 AFTER the write has
// committed. Both spellings have to work, since PAT callers hit Railway
// directly and keep using the documented header.
describe("X-If-Match alias", () => {
  it("accepts X-If-Match on a body edit", async () => {
    mockGetPostBySlug.mockResolvedValue(postRow());
    mockAppendVersion.mockResolvedValue({ versionNum: 4, id: "v4" });
    const res = await app.request("/api/blog/posts/hello-world", {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "X-Test-User": "u1",
        "X-If-Match": "3",
      },
      body: JSON.stringify({ content: "new body" }),
    });
    expect(res.status).toBe(200);
    expect(mockAppendVersion).toHaveBeenCalledWith(
      expect.objectContaining({ ifMatchVersionNum: 3 })
    );
  });

  it("accepts X-If-Match on a revert", async () => {
    mockGetPostBySlug.mockResolvedValue(postRow());
    mockRevert.mockResolvedValue({ versionNum: 5, id: "v5" });
    const res = await app.request("/api/blog/posts/hello-world/revert", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Test-User": "u1",
        "X-If-Match": "3",
      },
      body: JSON.stringify({ target_version_num: 1 }),
    });
    expect(res.status).toBe(200);
    expect(mockRevert).toHaveBeenCalledWith("p1", 1, "u1", 3);
  });

  it("still 428s when neither header is present", async () => {
    mockGetPostBySlug.mockResolvedValue(postRow());
    const res = await app.request("/api/blog/posts/hello-world", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "X-Test-User": "u1" },
      body: JSON.stringify({ content: "new body" }),
    });
    expect(res.status).toBe(428);
  });

  it("prefers If-Match when both are sent", async () => {
    mockGetPostBySlug.mockResolvedValue(postRow());
    mockAppendVersion.mockResolvedValue({ versionNum: 4, id: "v4" });
    await app.request("/api/blog/posts/hello-world", {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "X-Test-User": "u1",
        "If-Match": "3",
        "X-If-Match": "99",
      },
      body: JSON.stringify({ content: "new body" }),
    });
    expect(mockAppendVersion).toHaveBeenCalledWith(
      expect.objectContaining({ ifMatchVersionNum: 3 })
    );
  });
});
