// tests/modules/journal/comments-routes.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

const {
  mockGetByDate,
  mockCreateComment,
  mockListComments,
  mockUpdateComment,
  mockDeleteComment,
  mockGetVersion,
  mockGetSug,
  mockSelect,
} = vi.hoisted(() => ({
  mockGetByDate: vi.fn(),
  mockCreateComment: vi.fn(),
  mockListComments: vi.fn(),
  mockUpdateComment: vi.fn(),
  mockDeleteComment: vi.fn(),
  mockGetVersion: vi.fn(),
  mockGetSug: vi.fn(),
  mockSelect: vi.fn(),
}));

vi.mock("@/modules/journal/entries-repo", () => ({
  getEntryByDate: mockGetByDate,
  listEntries: vi.fn(),
  createEntry: vi.fn(),
  softDeleteEntry: vi.fn(),
  hashContent: (s: string) => s,
}));
vi.mock("@/modules/journal/versions-repo", () => ({
  appendDirectVersion: vi.fn(),
  listVersions: vi.fn(),
  getVersion: mockGetVersion,
  revertToVersion: vi.fn(),
  VersionConflictError: class extends Error {},
}));
vi.mock("@/modules/journal/suggestions-repo", () => ({
  createSuggestion: vi.fn(),
  listSuggestionsForEntry: vi.fn(),
  getSuggestion: mockGetSug,
  inboxFor: vi.fn(),
  approveSuggestion: vi.fn(),
  rejectSuggestion: vi.fn(),
  withdrawSuggestion: vi.fn(),
}));
vi.mock("@/modules/journal/comments-repo", () => ({
  createComment: mockCreateComment,
  listForEntry: mockListComments,
  getComment: vi.fn(),
  updateComment: mockUpdateComment,
  deleteComment: mockDeleteComment,
}));
vi.mock("@/db/client", () => ({ db: { select: mockSelect } }));
vi.mock("@/db/schema", () => ({
  journalEntries: {},
  journalVersions: {},
  journalSuggestions: {},
  journalComments: {},
}));
vi.mock("@/modules/auth/middleware", () => ({
  optionalAuth: async (c: any, next: any) => { c.set("userId", c.req.header("X-Test-User") ?? null); c.set("tokenScopes", null); await next(); },
  requireAuth: async (c: any, next: any) => {
    const u = c.req.header("X-Test-User");
    if (!u) return c.json({ error: "auth" }, 401);
    c.set("userId", u);
    c.set("tokenScopes", null);
    await next();
  },
  requireScope: () => async (_c: any, next: any) => { await next(); },
}));

import { journalRoutes } from "@/modules/journal/routes";

beforeEach(() => vi.clearAllMocks());
const app = new Hono().route("/api/journal", journalRoutes);

describe("GET /api/journal/entries/:date/comments", () => {
  it("returns the comment list", async () => {
    mockGetByDate.mockResolvedValue({ entry: { id: "e1" }, currentVersion: {} });
    mockListComments.mockResolvedValue([{ id: "c1" }, { id: "c2" }]);
    const res = await app.request("/api/journal/entries/2026-05-03/comments");
    expect(res.status).toBe(200);
    expect((await res.json()).comments).toHaveLength(2);
  });

  it("404 when entry missing", async () => {
    mockGetByDate.mockResolvedValue(null);
    const res = await app.request("/api/journal/entries/2026-05-03/comments");
    expect(res.status).toBe(404);
  });
});

describe("POST /api/journal/entries/:date/comments", () => {
  it("creates a comment", async () => {
    mockGetByDate.mockResolvedValue({ entry: { id: "e1" }, currentVersion: {} });
    mockCreateComment.mockResolvedValue({ id: "c1", content: "nice" });
    const res = await app.request("/api/journal/entries/2026-05-03/comments", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Test-User": "u1" },
      body: JSON.stringify({ content: "nice" }),
    });
    expect(res.status).toBe(201);
    expect(mockCreateComment).toHaveBeenCalledWith(expect.objectContaining({ entryId: "e1", authorId: "u1", content: "nice" }));
  });

  it("creates a nested reply when parent_comment_id is provided", async () => {
    mockGetByDate.mockResolvedValue({ entry: { id: "e1" }, currentVersion: {} });
    mockCreateComment.mockResolvedValue({ id: "c2" });
    await app.request("/api/journal/entries/2026-05-03/comments", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Test-User": "u1" },
      body: JSON.stringify({ content: "reply", parent_comment_id: "00000000-0000-0000-0000-000000000001" }),
    });
    expect(mockCreateComment).toHaveBeenCalledWith(expect.objectContaining({
      parentCommentId: "00000000-0000-0000-0000-000000000001",
    }));
  });

  it("401 without auth", async () => {
    const res = await app.request("/api/journal/entries/2026-05-03/comments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "x" }),
    });
    expect(res.status).toBe(401);
  });
});

describe("PATCH /api/journal/comments/:id", () => {
  it("updates when caller is author", async () => {
    mockUpdateComment.mockResolvedValue({ id: "c1", content: "edited" });
    const res = await app.request("/api/journal/comments/c1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "X-Test-User": "u1" },
      body: JSON.stringify({ content: "edited" }),
    });
    expect(res.status).toBe(200);
  });

  it("404 when not author / not found", async () => {
    mockUpdateComment.mockResolvedValue(null);
    const res = await app.request("/api/journal/comments/c1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "X-Test-User": "u1" },
      body: JSON.stringify({ content: "x" }),
    });
    expect(res.status).toBe(404);
  });
});

describe("DELETE /api/journal/comments/:id", () => {
  it("204 when caller is permitted", async () => {
    mockDeleteComment.mockResolvedValue(true);
    const res = await app.request("/api/journal/comments/c1", {
      method: "DELETE",
      headers: { "X-Test-User": "u1" },
    });
    expect(res.status).toBe(204);
  });

  it("404 when caller is not permitted", async () => {
    mockDeleteComment.mockResolvedValue(false);
    const res = await app.request("/api/journal/comments/c1", {
      method: "DELETE",
      headers: { "X-Test-User": "stranger" },
    });
    expect(res.status).toBe(404);
  });
});
