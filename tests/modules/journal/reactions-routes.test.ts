// tests/modules/journal/reactions-routes.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

const {
  mockGetByDate,
  mockToggleEntry,
  mockToggleComment,
  mockGetVersion,
  mockGetSug,
  mockSelect,
  mockSummarizeEntry,
  mockListMyEntryReactions,
  mockSummarizeComment,
  mockListMyCommentReactions,
} = vi.hoisted(() => ({
  mockGetByDate: vi.fn(),
  mockToggleEntry: vi.fn(),
  mockToggleComment: vi.fn(),
  mockGetVersion: vi.fn(),
  mockGetSug: vi.fn(),
  mockSelect: vi.fn(),
  mockSummarizeEntry: vi.fn(),
  mockListMyEntryReactions: vi.fn(),
  mockSummarizeComment: vi.fn(),
  mockListMyCommentReactions: vi.fn(),
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
  createComment: vi.fn(),
  listForEntry: vi.fn(),
  getComment: vi.fn(),
  updateComment: vi.fn(),
  deleteComment: vi.fn(),
}));
vi.mock("@/modules/journal/reactions-repo", () => ({
  toggleEntryReaction: mockToggleEntry,
  toggleCommentReaction: mockToggleComment,
  summarizeEntryReactions: mockSummarizeEntry,
  summarizeCommentReactions: mockSummarizeComment,
  listMyReactionsForEntry: mockListMyEntryReactions,
  listMyReactionsForComment: mockListMyCommentReactions,
  isAllowedEmoji: (e: string) => ["+1", "-1", "laugh", "heart", "hooray", "rocket", "eyes", "confused"].includes(e),
  ALLOWED_EMOJI: ["+1", "-1", "laugh", "heart", "hooray", "rocket", "eyes", "confused"],
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

describe("POST /api/journal/entries/:date/reactions", () => {
  it("toggles 'added' on first call", async () => {
    mockGetByDate.mockResolvedValue({ entry: { id: "e1" }, currentVersion: {} });
    mockToggleEntry.mockResolvedValue("added");
    const res = await app.request("/api/journal/entries/2026-05-03/reactions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Test-User": "u1" },
      body: JSON.stringify({ emoji: "rocket" }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).result).toBe("added");
  });

  it("toggles 'removed' on second call", async () => {
    mockGetByDate.mockResolvedValue({ entry: { id: "e1" }, currentVersion: {} });
    mockToggleEntry.mockResolvedValue("removed");
    const res = await app.request("/api/journal/entries/2026-05-03/reactions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Test-User": "u1" },
      body: JSON.stringify({ emoji: "rocket" }),
    });
    expect((await res.json()).result).toBe("removed");
  });

  it("400 on invalid emoji", async () => {
    mockGetByDate.mockResolvedValue({ entry: { id: "e1" }, currentVersion: {} });
    const res = await app.request("/api/journal/entries/2026-05-03/reactions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Test-User": "u1" },
      body: JSON.stringify({ emoji: "smile" }),
    });
    expect(res.status).toBe(400);
  });

  it("404 when entry missing", async () => {
    mockGetByDate.mockResolvedValue(null);
    const res = await app.request("/api/journal/entries/2026-05-03/reactions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Test-User": "u1" },
      body: JSON.stringify({ emoji: "rocket" }),
    });
    expect(res.status).toBe(404);
  });

  it("401 without auth", async () => {
    const res = await app.request("/api/journal/entries/2026-05-03/reactions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ emoji: "rocket" }),
    });
    expect(res.status).toBe(401);
  });
});

describe("POST /api/journal/comments/:id/reactions", () => {
  it("toggles 'added'", async () => {
    mockToggleComment.mockResolvedValue("added");
    const res = await app.request("/api/journal/comments/c1/reactions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Test-User": "u1" },
      body: JSON.stringify({ emoji: "heart" }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).result).toBe("added");
    expect(mockToggleComment).toHaveBeenCalledWith("u1", "c1", "heart");
  });

  it("400 on invalid emoji", async () => {
    const res = await app.request("/api/journal/comments/c1/reactions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Test-User": "u1" },
      body: JSON.stringify({ emoji: "thumbsup" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("GET /api/journal/entries/:date/reactions", () => {
  it("returns summary + empty mine for anon caller", async () => {
    mockGetByDate.mockResolvedValue({ entry: { id: "e1" }, currentVersion: {} });
    mockSummarizeEntry.mockResolvedValue([{ emoji: "rocket", count: 3 }]);
    const res = await app.request("/api/journal/entries/2026-05-03/reactions");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.summary).toEqual([{ emoji: "rocket", count: 3 }]);
    expect(body.mine).toEqual([]);
  });

  it("returns mine for authed caller", async () => {
    mockGetByDate.mockResolvedValue({ entry: { id: "e1" }, currentVersion: {} });
    mockSummarizeEntry.mockResolvedValue([{ emoji: "rocket", count: 3 }, { emoji: "heart", count: 1 }]);
    mockListMyEntryReactions.mockResolvedValue([{ emoji: "rocket" }]);
    const res = await app.request("/api/journal/entries/2026-05-03/reactions", { headers: { "X-Test-User": "u1" } });
    const body = await res.json();
    expect(body.mine).toEqual(["rocket"]);
  });

  it("404 when entry missing", async () => {
    mockGetByDate.mockResolvedValue(null);
    const res = await app.request("/api/journal/entries/2026-05-03/reactions");
    expect(res.status).toBe(404);
  });
});

describe("GET /api/journal/comments/:id/reactions", () => {
  it("returns summary + mine", async () => {
    mockSummarizeComment.mockResolvedValue([{ emoji: "hooray", count: 2 }]);
    mockListMyCommentReactions.mockResolvedValue([{ emoji: "hooray" }]);
    const res = await app.request("/api/journal/comments/c1/reactions", { headers: { "X-Test-User": "u1" } });
    const body = await res.json();
    expect(body.summary).toEqual([{ emoji: "hooray", count: 2 }]);
    expect(body.mine).toEqual(["hooray"]);
  });
});
