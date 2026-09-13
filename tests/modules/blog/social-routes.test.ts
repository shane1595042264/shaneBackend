// tests/modules/blog/social-routes.test.ts — SHAN-488 Phase 4
//
// The comment/reaction half of modules/blog/routes.ts. The load-bearing
// assertion in this file is not "a comment can be posted" — it's that the
// membership gate really is absent (reads work with no Authorization header at
// all) while drafts and trashed posts still stay invisible, because both of
// those flow from the same getPostBySlug(slug, viewerId) call.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

const {
  mockGetPostBySlug,
  mockCreateComment,
  mockListComments,
  mockUpdateComment,
  mockDeleteComment,
  mockToggleReaction,
  mockSummarize,
  mockListMine,
} = vi.hoisted(() => ({
  mockGetPostBySlug: vi.fn(),
  mockCreateComment: vi.fn(),
  mockListComments: vi.fn(),
  mockUpdateComment: vi.fn(),
  mockDeleteComment: vi.fn(),
  mockToggleReaction: vi.fn(),
  mockSummarize: vi.fn(),
  mockListMine: vi.fn(),
}));

vi.mock("@/modules/blog/posts-repo", () => ({
  createPost: vi.fn(),
  getPostBySlug: mockGetPostBySlug,
  listPosts: vi.fn(),
  slugTaken: vi.fn().mockResolvedValue(false),
  softDeletePost: vi.fn(),
  updatePostMeta: vi.fn(),
  hashContent: (s: string) => "hash-" + s.length,
}));

vi.mock("@/modules/blog/versions-repo", async () => {
  class VersionConflictError extends Error {
    constructor(public currentVersionNum: number) {
      super("VersionConflict");
      this.name = "VersionConflict";
    }
  }
  return {
    appendDirectVersion: vi.fn(),
    getVersion: vi.fn(),
    listVersions: vi.fn(),
    revertToVersion: vi.fn(),
    VersionConflictError,
  };
});

vi.mock("@/modules/blog/comments-repo", () => ({
  createComment: mockCreateComment,
  listForPost: mockListComments,
  updateComment: mockUpdateComment,
  deleteComment: mockDeleteComment,
  getComment: vi.fn(),
}));

vi.mock("@/modules/blog/reactions-repo", () => ({
  togglePostReaction: mockToggleReaction,
  summarizePostReactions: mockSummarize,
  listMyReactionsForPost: mockListMine,
}));

vi.mock("@/modules/auth/user-prefs", () => ({
  getUserTimezone: vi.fn().mockResolvedValue("Europe/Athens"),
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

const app = new Hono().route("/api/blog", blogRoutes);

const COMMENT_ID = "11111111-2222-4333-8444-555555555555";

const postRow = (over: Record<string, unknown> = {}) => ({
  post: { id: "p1", slug: "hello-world", authorId: "u1", status: "published", ...over },
  currentVersion: { versionNum: 1, title: "Hello World", content: "body" },
  author: { id: "u1", name: "Shane", avatarUrl: null },
});

beforeEach(() => {
  vi.clearAllMocks();
  mockGetPostBySlug.mockResolvedValue(postRow());
});

describe("GET /api/blog/posts/:slug/comments", () => {
  it("is readable with no Authorization header at all", async () => {
    mockListComments.mockResolvedValue([{ id: "c1", content: "hi" }]);
    const res = await app.request("/api/blog/posts/hello-world/comments");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ comments: [{ id: "c1", content: "hi" }] });
  });

  it("passes the viewer to getPostBySlug so a draft author sees their own thread", async () => {
    mockListComments.mockResolvedValue([]);
    await app.request("/api/blog/posts/hello-world/comments", {
      headers: { "X-Test-User": "u1" },
    });
    expect(mockGetPostBySlug).toHaveBeenCalledWith("hello-world", "u1");
  });

  it("404s when the post is invisible to the caller", async () => {
    mockGetPostBySlug.mockResolvedValue(null);
    const res = await app.request("/api/blog/posts/hello-world/comments");
    expect(res.status).toBe(404);
    expect(mockListComments).not.toHaveBeenCalled();
  });

  it("rejects a slug the column could never hold", async () => {
    const res = await app.request("/api/blog/posts/Not%20A%20Slug!/comments");
    expect(res.status).toBe(400);
  });
});

describe("POST /api/blog/posts/:slug/comments", () => {
  it("401s an anonymous writer", async () => {
    const res = await app.request("/api/blog/posts/hello-world/comments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "nice post" }),
    });
    expect(res.status).toBe(401);
    expect(mockCreateComment).not.toHaveBeenCalled();
  });

  it("lets any signed-in user comment, not just the post author", async () => {
    mockCreateComment.mockResolvedValue({ id: "c1", content: "nice post" });
    const res = await app.request("/api/blog/posts/hello-world/comments", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Test-User": "u2" },
      body: JSON.stringify({ content: "nice post" }),
    });
    expect(res.status).toBe(201);
    expect(mockCreateComment).toHaveBeenCalledWith({
      postId: "p1",
      authorId: "u2",
      authorTimezone: "Europe/Athens",
      content: "nice post",
    });
  });

  it("trims the body and rejects one that is only whitespace", async () => {
    const res = await app.request("/api/blog/posts/hello-world/comments", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Test-User": "u2" },
      body: JSON.stringify({ content: "   \n  " }),
    });
    expect(res.status).toBe(400);
    expect(mockCreateComment).not.toHaveBeenCalled();
  });

  it("rejects a body still holding an in-flight upload placeholder", async () => {
    const res = await app.request("/api/blog/posts/hello-world/comments", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Test-User": "u2" },
      body: JSON.stringify({ content: "look: ![shot](uploading-k3f9x-1757700000000)" }),
    });
    expect(res.status).toBe(400);
    expect(mockCreateComment).not.toHaveBeenCalled();
  });

  it("404s rather than orphaning a comment on an invisible post", async () => {
    mockGetPostBySlug.mockResolvedValue(null);
    const res = await app.request("/api/blog/posts/hello-world/comments", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Test-User": "u2" },
      body: JSON.stringify({ content: "nice post" }),
    });
    expect(res.status).toBe(404);
    expect(mockCreateComment).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/blog/comments/:id", () => {
  it("edits the caller's own comment", async () => {
    mockUpdateComment.mockResolvedValue({ id: COMMENT_ID, content: "fixed" });
    const res = await app.request(`/api/blog/comments/${COMMENT_ID}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "X-Test-User": "u2" },
      body: JSON.stringify({ content: "fixed" }),
    });
    expect(res.status).toBe(200);
    expect(mockUpdateComment).toHaveBeenCalledWith(COMMENT_ID, "u2", "fixed");
  });

  it("404s when the repo refuses (unknown id or not the author)", async () => {
    mockUpdateComment.mockResolvedValue(null);
    const res = await app.request(`/api/blog/comments/${COMMENT_ID}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "X-Test-User": "u3" },
      body: JSON.stringify({ content: "hijack" }),
    });
    expect(res.status).toBe(404);
  });

  it("400s a non-uuid id before it reaches the repo", async () => {
    const res = await app.request("/api/blog/comments/not-a-uuid", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "X-Test-User": "u2" },
      body: JSON.stringify({ content: "x" }),
    });
    expect(res.status).toBe(400);
    expect(mockUpdateComment).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/blog/comments/:id", () => {
  it("204s and hands the caller id to the repo for the author check", async () => {
    mockDeleteComment.mockResolvedValue(true);
    const res = await app.request(`/api/blog/comments/${COMMENT_ID}`, {
      method: "DELETE",
      headers: { "X-Test-User": "u1" },
    });
    expect(res.status).toBe(204);
    expect(mockDeleteComment).toHaveBeenCalledWith(COMMENT_ID, "u1");
  });

  it("404s when the caller is neither the comment author nor the post author", async () => {
    mockDeleteComment.mockResolvedValue(false);
    const res = await app.request(`/api/blog/comments/${COMMENT_ID}`, {
      method: "DELETE",
      headers: { "X-Test-User": "u9" },
    });
    expect(res.status).toBe(404);
  });

  it("401s an anonymous deleter", async () => {
    const res = await app.request(`/api/blog/comments/${COMMENT_ID}`, { method: "DELETE" });
    expect(res.status).toBe(401);
    expect(mockDeleteComment).not.toHaveBeenCalled();
  });
});

describe("GET /api/blog/posts/:slug/reactions", () => {
  it("returns counts to an anonymous reader with an empty `mine`", async () => {
    mockSummarize.mockResolvedValue([{ emoji: "heart", count: 4 }]);
    const res = await app.request("/api/blog/posts/hello-world/reactions");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ summary: [{ emoji: "heart", count: 4 }], mine: [] });
    // No viewer, so no per-user query should have been issued at all.
    expect(mockListMine).not.toHaveBeenCalled();
  });

  it("fills `mine` for a signed-in reader", async () => {
    mockSummarize.mockResolvedValue([{ emoji: "heart", count: 4 }]);
    mockListMine.mockResolvedValue([{ emoji: "heart" }]);
    const res = await app.request("/api/blog/posts/hello-world/reactions", {
      headers: { "X-Test-User": "u2" },
    });
    expect((await res.json()).mine).toEqual(["heart"]);
  });
});

describe("POST /api/blog/posts/:slug/reactions", () => {
  it("toggles and echoes the repo's verdict", async () => {
    mockToggleReaction.mockResolvedValue("added");
    const res = await app.request("/api/blog/posts/hello-world/reactions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Test-User": "u2" },
      body: JSON.stringify({ emoji: "rocket" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ result: "added" });
    expect(mockToggleReaction).toHaveBeenCalledWith("u2", "p1", "rocket");
  });

  it("reports removal so the second click reads as an undo", async () => {
    mockToggleReaction.mockResolvedValue("removed");
    const res = await app.request("/api/blog/posts/hello-world/reactions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Test-User": "u2" },
      body: JSON.stringify({ emoji: "rocket" }),
    });
    expect(await res.json()).toEqual({ result: "removed" });
  });

  it("400s an emoji outside the shared allowlist instead of letting the enum cast throw", async () => {
    const res = await app.request("/api/blog/posts/hello-world/reactions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Test-User": "u2" },
      body: JSON.stringify({ emoji: "pineapple" }),
    });
    expect(res.status).toBe(400);
    expect(mockToggleReaction).not.toHaveBeenCalled();
  });

  it("401s an anonymous reactor", async () => {
    const res = await app.request("/api/blog/posts/hello-world/reactions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ emoji: "heart" }),
    });
    expect(res.status).toBe(401);
  });
});
