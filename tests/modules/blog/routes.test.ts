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
