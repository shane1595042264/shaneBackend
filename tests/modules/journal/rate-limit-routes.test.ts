// Covers the per-PAT rate limit applied to every requireScope-protected write
// endpoint in journal/routes.ts. JWTs (no tokenId) must bypass; PATs (tokenId
// set) must 429 once the per-bucket per-minute limit fills. Buckets are split
// by scope so traffic on one scope doesn't lock out another.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { __resetRateLimitBuckets } from "@/modules/shared/rate-limit";

const {
  mockGetByDate,
  mockCreateAppend,
  mockCreateComment,
  mockToggleEntryReaction,
  mockIsAllowedEmoji,
} = vi.hoisted(() => ({
  mockGetByDate: vi.fn(),
  mockCreateAppend: vi.fn(),
  mockCreateComment: vi.fn(),
  mockToggleEntryReaction: vi.fn(),
  mockIsAllowedEmoji: vi.fn().mockReturnValue(true),
}));

vi.mock("@/modules/journal/entries-repo", () => ({
  listEntries: vi.fn(),
  getEntryByDate: mockGetByDate,
  createEntry: vi.fn(),
  softDeleteEntry: vi.fn(),
}));
vi.mock("@/modules/journal/appends-repo", () => ({
  listAppendsForEntry: vi.fn().mockResolvedValue([]),
  createAppend: mockCreateAppend,
}));
vi.mock("@/modules/journal/comments-repo", () => ({
  createComment: mockCreateComment,
  listForEntry: vi.fn(),
  updateComment: vi.fn(),
  deleteComment: vi.fn(),
  getComment: vi.fn(),
}));
vi.mock("@/modules/journal/reactions-repo", () => ({
  toggleEntryReaction: mockToggleEntryReaction,
  toggleCommentReaction: vi.fn(),
  isAllowedEmoji: mockIsAllowedEmoji,
  summarizeEntryReactions: vi.fn(),
  listMyReactionsForEntry: vi.fn(),
  summarizeCommentReactions: vi.fn(),
  listMyReactionsForComment: vi.fn(),
}));
vi.mock("@/modules/journal/versions-repo", () => ({
  listVersions: vi.fn(),
  getVersion: vi.fn(),
  revertToVersion: vi.fn(),
  VersionConflictError: class extends Error {},
}));
vi.mock("@/modules/journal/suggestions-repo", () => ({
  createSuggestion: vi.fn(),
  getSuggestion: vi.fn(),
  listSuggestionsForEntry: vi.fn(),
  approveSuggestion: vi.fn(),
  rejectSuggestion: vi.fn(),
  withdrawSuggestion: vi.fn(),
  inboxFor: vi.fn(),
}));
vi.mock("@/modules/journal/images-repo", () => ({
  insertImage: vi.fn(),
  getImageById: vi.fn(),
  countUploadsInWindow: vi.fn().mockResolvedValue({ count: 0, oldestCreatedAt: null }),
}));

vi.mock("@/modules/auth/user-prefs", () => ({
  getUserTimezone: vi.fn().mockResolvedValue("America/Chicago"),
  DEFAULT_TIMEZONE: "America/Chicago",
}));

// Custom auth mock: X-Test-Token presence flips the request from "JWT" to
// "PAT" by setting tokenId. The real limiter only counts when tokenId is
// non-null, so this is the toggle that exercises the limiter under test.
vi.mock("@/modules/auth/middleware", () => ({
  optionalAuth: async (c: any, next: any) => {
    c.set("userId", c.req.header("X-Test-User") ?? null);
    const token = c.req.header("X-Test-Token");
    c.set("tokenScopes", token ? [] : null);
    c.set("tokenId", token ?? null);
    await next();
  },
  requireAuth: async (c: any, next: any) => {
    const u = c.req.header("X-Test-User");
    if (!u) return c.json({ error: "auth" }, 401);
    c.set("userId", u);
    const token = c.req.header("X-Test-Token");
    c.set("tokenScopes", token ? [] : null);
    c.set("tokenId", token ?? null);
    await next();
  },
  requireScope: () => async (_c: any, next: any) => { await next(); },
}));

import { journalRoutes } from "@/modules/journal/routes";

beforeEach(() => {
  vi.clearAllMocks();
  __resetRateLimitBuckets();
});

const app = new Hono().route("/api/journal", journalRoutes);

const ENTRY = {
  entry: { id: "e1", date: "2026-04-29", authorId: "u-author" },
  currentVersion: { id: "v1", versionNum: 1, content: "hi" },
};

function patHeaders(token = "pat-test") {
  return {
    "Content-Type": "application/json",
    "X-Test-User": "u-author",
    "X-Test-Token": token,
  };
}
function jwtHeaders() {
  return {
    "Content-Type": "application/json",
    "X-Test-User": "u-author",
  };
}

describe("journal write rate limits (per PAT)", () => {
  it("comments-write bucket 429s a PAT after 30 POSTs in a minute", async () => {
    mockGetByDate.mockResolvedValue(ENTRY);
    mockCreateComment.mockResolvedValue({ id: "c1" });
    const headers = patHeaders();
    const body = JSON.stringify({ content: "hello" });

    for (let i = 0; i < 30; i++) {
      const ok = await app.request("/api/journal/entries/2026-04-29/comments", {
        method: "POST",
        headers,
        body,
      });
      expect(ok.status).toBe(201);
    }
    const blocked = await app.request("/api/journal/entries/2026-04-29/comments", {
      method: "POST",
      headers,
      body,
    });
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("Retry-After")).toBe("60");
  });

  it("JWT requests with no tokenId bypass the limiter regardless of count", async () => {
    mockGetByDate.mockResolvedValue(ENTRY);
    mockCreateComment.mockResolvedValue({ id: "c1" });
    const headers = jwtHeaders();
    const body = JSON.stringify({ content: "hello" });

    for (let i = 0; i < 40; i++) {
      const res = await app.request("/api/journal/entries/2026-04-29/comments", {
        method: "POST",
        headers,
        body,
      });
      expect(res.status).toBe(201);
    }
  });

  it("isolates bucket per PAT id so one client doesn't lock out another", async () => {
    mockGetByDate.mockResolvedValue(ENTRY);
    mockCreateComment.mockResolvedValue({ id: "c1" });
    const body = JSON.stringify({ content: "hi" });

    for (let i = 0; i < 30; i++) {
      const r = await app.request("/api/journal/entries/2026-04-29/comments", {
        method: "POST",
        headers: patHeaders("pat-alpha"),
        body,
      });
      expect(r.status).toBe(201);
    }
    const alphaBlocked = await app.request("/api/journal/entries/2026-04-29/comments", {
      method: "POST",
      headers: patHeaders("pat-alpha"),
      body,
    });
    expect(alphaBlocked.status).toBe(429);

    // A different PAT keeps its own counter.
    const beta = await app.request("/api/journal/entries/2026-04-29/comments", {
      method: "POST",
      headers: patHeaders("pat-beta"),
      body,
    });
    expect(beta.status).toBe(201);
  });

  it("comments bucket is independent from reactions bucket", async () => {
    mockGetByDate.mockResolvedValue(ENTRY);
    mockCreateComment.mockResolvedValue({ id: "c1" });
    mockToggleEntryReaction.mockResolvedValue({ added: true });
    const headers = patHeaders();

    // Burn the comments bucket.
    for (let i = 0; i < 30; i++) {
      const r = await app.request("/api/journal/entries/2026-04-29/comments", {
        method: "POST",
        headers,
        body: JSON.stringify({ content: "x" }),
      });
      expect(r.status).toBe(201);
    }
    const commentBlocked = await app.request("/api/journal/entries/2026-04-29/comments", {
      method: "POST",
      headers,
      body: JSON.stringify({ content: "x" }),
    });
    expect(commentBlocked.status).toBe(429);

    // Reactions still go through — separate bucket, separate counter.
    const reaction = await app.request("/api/journal/entries/2026-04-29/reactions", {
      method: "POST",
      headers,
      body: JSON.stringify({ emoji: "👍" }),
    });
    expect(reaction.status).toBe(200);
  });

  it("appends/revert share the entries-write bucket (single counter)", async () => {
    mockGetByDate.mockResolvedValue(ENTRY);
    mockCreateAppend.mockResolvedValue({ id: "a1" });
    const headers = patHeaders();

    // 30 appends — fills the entries-write bucket.
    for (let i = 0; i < 30; i++) {
      const r = await app.request("/api/journal/entries/2026-04-29/appends", {
        method: "POST",
        headers,
        body: JSON.stringify({ content: "more" }),
      });
      expect(r.status).toBe(201);
    }
    // 31st append: bucket full.
    const blockedAppend = await app.request("/api/journal/entries/2026-04-29/appends", {
      method: "POST",
      headers,
      body: JSON.stringify({ content: "more" }),
    });
    expect(blockedAppend.status).toBe(429);
  });
});
