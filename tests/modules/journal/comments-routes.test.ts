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
  mockGetComment,
  mockGetAppend,
  mockRecordActivity,
} = vi.hoisted(() => ({
  mockRecordActivity: vi.fn().mockResolvedValue(undefined),
  mockGetAppend: vi.fn(),
  mockGetComment: vi.fn(),
  mockGetByDate: vi.fn(),
  mockCreateComment: vi.fn(),
  mockListComments: vi.fn(),
  mockUpdateComment: vi.fn(),
  mockDeleteComment: vi.fn(),
  mockGetVersion: vi.fn(),
  mockGetSug: vi.fn(),
  mockSelect: vi.fn(),
}));

vi.mock("@/modules/auth/user-prefs", () => ({
  getUserTimezone: vi.fn().mockResolvedValue("America/Chicago"),
  DEFAULT_TIMEZONE: "America/Chicago",
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
  getComment: mockGetComment,
  updateComment: mockUpdateComment,
  deleteComment: mockDeleteComment,
}));
vi.mock("@/modules/journal/appends-repo", () => ({
  createAppend: vi.fn(),
  getAppend: mockGetAppend,
  listAppendsForEntry: vi.fn(),
  updateAppend: vi.fn(),
  softDeleteAppend: vi.fn(),
}));
vi.mock("@/db/client", () => ({ db: { select: mockSelect } }));
vi.mock("@/modules/journal/activity-repo", () => ({
  recordActivity: mockRecordActivity,
  listActivity: vi.fn(),
  listActivityForEntry: vi.fn(),
}));
vi.mock("@/db/schema", () => ({
  journalEntries: {},
  journalVersions: {},
  journalSuggestions: {},
  journalComments: {},
}));
// SHAN-475: every journal route now runs requireJournalMembership. These
// suites are about the routes, not the gate, so let everyone through here;
// the gate itself is covered in access-middleware.test.ts.
vi.mock("@/modules/journal/access-middleware", () => ({
  requireJournalMembership: async (_c: any, next: any) => { await next(); },
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

beforeEach(() => {
  vi.clearAllMocks();
  // SHAN-483: comment mutations now look the parent entry's date up via
  // db.select() to stamp an audit row. Default it to a resolvable date so
  // these route assertions stay about the comment behaviour.
  const chain: Record<string, unknown> = {};
  const promise = Promise.resolve([{ authorId: "u1", date: "2026-05-03" }]);
  for (const m of ["from", "where", "limit"]) chain[m] = vi.fn(() => chain);
  Object.assign(chain, { then: (r: any, j: any) => promise.then(r, j) });
  mockSelect.mockReturnValue(chain);
});
const app = new Hono().route("/api/journal", journalRoutes);

// Valid UUID for :id path params — routes now reject malformed UUIDs with 400.
const CID = "22222222-2222-4222-8222-222222222222";

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
    mockGetComment.mockResolvedValue({ id: "00000000-0000-0000-0000-000000000001", entryId: "e1", parentCommentId: null });
    const res = await app.request("/api/journal/entries/2026-05-03/comments", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Test-User": "u1" },
      body: JSON.stringify({ content: "reply", parent_comment_id: "00000000-0000-0000-0000-000000000001" }),
    });
    expect(res.status).toBe(201);
    expect(mockCreateComment).toHaveBeenCalledWith(expect.objectContaining({
      parentCommentId: "00000000-0000-0000-0000-000000000001",
    }));
  });

  // SHAN-574: the thread UI only draws replies under a top-level comment on
  // the same entry, so any other parent would be a 201 for an invisible row.
  it.each([
    ["does not exist", null],
    ["is on another entry", { id: "p1", entryId: "e-other", parentCommentId: null }],
    ["is itself a reply", { id: "p1", entryId: "e1", parentCommentId: "p0" }],
  ])("400s when the parent %s", async (_label, parent) => {
    mockGetByDate.mockResolvedValue({ entry: { id: "e1" }, currentVersion: {} });
    mockGetComment.mockResolvedValue(parent);
    const res = await app.request("/api/journal/entries/2026-05-03/comments", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Test-User": "u1" },
      body: JSON.stringify({ content: "reply", parent_comment_id: "00000000-0000-0000-0000-000000000001" }),
    });
    expect(res.status).toBe(400);
    expect(mockCreateComment).not.toHaveBeenCalled();
  });

  it("401 without auth", async () => {
    const res = await app.request("/api/journal/entries/2026-05-03/comments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "x" }),
    });
    expect(res.status).toBe(401);
  });

  // SHAN-431: whitespace-only comment 400s instead of posting a blank comment.
  it("returns 400 on whitespace-only comment content (SHAN-431)", async () => {
    mockGetByDate.mockResolvedValue({ entry: { id: "e1" }, currentVersion: {} });
    const res = await app.request("/api/journal/entries/2026-05-03/comments", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Test-User": "u1" },
      body: JSON.stringify({ content: "   \n  " }),
    });
    expect(res.status).toBe(400);
    expect(mockCreateComment).not.toHaveBeenCalled();
  });

  it("trims incidental padding from comment content before persisting (SHAN-431)", async () => {
    mockGetByDate.mockResolvedValue({ entry: { id: "e1" }, currentVersion: {} });
    mockCreateComment.mockResolvedValue({ id: "c1", content: "nice" });
    const res = await app.request("/api/journal/entries/2026-05-03/comments", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Test-User": "u1" },
      body: JSON.stringify({ content: "  nice  " }),
    });
    expect(res.status).toBe(201);
    expect(mockCreateComment).toHaveBeenCalledWith(expect.objectContaining({ content: "nice" }));
  });
});

describe("PATCH /api/journal/comments/:id", () => {
  it("updates when caller is author", async () => {
    mockUpdateComment.mockResolvedValue({ id: "c1", content: "edited" });
    const res = await app.request(`/api/journal/comments/${CID}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "X-Test-User": "u1" },
      body: JSON.stringify({ content: "edited" }),
    });
    expect(res.status).toBe(200);
  });

  it("404 when not author / not found", async () => {
    mockUpdateComment.mockResolvedValue(null);
    const res = await app.request(`/api/journal/comments/${CID}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "X-Test-User": "u1" },
      body: JSON.stringify({ content: "x" }),
    });
    expect(res.status).toBe(404);
  });

  // SHAN-431: whitespace-only edit 400s instead of blanking the comment.
  it("returns 400 on whitespace-only edit content (SHAN-431)", async () => {
    const res = await app.request(`/api/journal/comments/${CID}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "X-Test-User": "u1" },
      body: JSON.stringify({ content: "   " }),
    });
    expect(res.status).toBe(400);
    expect(mockUpdateComment).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/journal/comments/:id", () => {
  it("204 when caller is permitted", async () => {
    mockDeleteComment.mockResolvedValue(true);
    const res = await app.request(`/api/journal/comments/${CID}`, {
      method: "DELETE",
      headers: { "X-Test-User": "u1" },
    });
    expect(res.status).toBe(204);
  });

  it("404 when caller is not permitted", async () => {
    mockDeleteComment.mockResolvedValue(false);
    const res = await app.request(`/api/journal/comments/${CID}`, {
      method: "DELETE",
      headers: { "X-Test-User": "stranger" },
    });
    expect(res.status).toBe(404);
  });
});

describe("POST /api/journal/entries/:date/comments with an anchor (SHAN-577)", () => {
  const APPEND = "33333333-3333-4333-8333-333333333333";
  const post = (body: unknown) =>
    app.request("/api/journal/entries/2026-05-03/comments", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Test-User": "u1" },
      body: JSON.stringify(body),
    });

  beforeEach(() => {
    mockGetByDate.mockResolvedValue({ entry: { id: "e1" }, currentVersion: {} });
    mockCreateComment.mockResolvedValue({ id: "n1" });
  });

  it("stores a note on the entry body, filling empty context", async () => {
    const res = await post({ content: "nice word", anchor: { target: "entry", quote: " ring buffer " } });
    expect(res.status).toBe(201);
    expect(mockCreateComment).toHaveBeenCalledWith(
      expect.objectContaining({ anchor: { target: "entry", quote: "ring buffer", prefix: "", suffix: "" } })
    );
  });

  it("stores a note on an append of this entry", async () => {
    mockGetAppend.mockResolvedValue({ id: APPEND, entryId: "e1", deletedAt: null });
    const res = await post({ content: "x", anchor: { target: APPEND, quote: "q", prefix: "a", suffix: "b" } });
    expect(res.status).toBe(201);
    expect(mockCreateComment.mock.calls[0][0].anchor.target).toBe(APPEND);
  });

  it("rejects an append from another entry, or a deleted one", async () => {
    mockGetAppend.mockResolvedValue({ id: APPEND, entryId: "other", deletedAt: null });
    expect((await post({ content: "x", anchor: { target: APPEND, quote: "q" } })).status).toBe(400);
    mockGetAppend.mockResolvedValue({ id: APPEND, entryId: "e1", deletedAt: new Date() });
    expect((await post({ content: "x", anchor: { target: APPEND, quote: "q" } })).status).toBe(400);
    mockGetAppend.mockResolvedValue(null);
    expect((await post({ content: "x", anchor: { target: APPEND, quote: "q" } })).status).toBe(400);
    expect(mockCreateComment).not.toHaveBeenCalled();
  });

  it("rejects an anchor on a reply", async () => {
    mockGetComment.mockResolvedValue({ id: CID, entryId: "e1", parentCommentId: null });
    const res = await post({ content: "x", parent_comment_id: CID, anchor: { target: "entry", quote: "q" } });
    expect(res.status).toBe(400);
    expect(mockCreateComment).not.toHaveBeenCalled();
  });

  it("validates the anchor shape", async () => {
    for (const anchor of [
      { target: "entry", quote: "   " },
      { target: "entry" },
      { target: "nope", quote: "q" },
      { target: "entry", quote: "q", prefix: "x".repeat(65) },
      { target: "entry", quote: "q", offset: 4 },
      { target: "entry", quote: "\uD83D" },
    ]) {
      expect((await post({ content: "x", anchor })).status).toBe(400);
    }
    expect(mockCreateComment).not.toHaveBeenCalled();
  });

  // SHAN-578: a half emoji serializes to an escape Postgres refuses in jsonb.
  it("drops the half of an emoji the 64-character context cut", async () => {
    const res = await post({
      content: "x",
      anchor: { target: "entry", quote: "ring buffer", prefix: "\uDE00 before ", suffix: " after \uD83D" },
    });
    expect(res.status).toBe(201);
    expect(mockCreateComment.mock.calls[0][0].anchor).toEqual({
      target: "entry",
      quote: "ring buffer",
      prefix: " before ",
      suffix: " after ",
    });
  });

  it("keeps whole emoji and records a well-formed activity quote when 200 splits one", async () => {
    const quote = `${"a".repeat(199)}\u{1F600}tail`;
    const res = await post({ content: "x", anchor: { target: "entry", quote, prefix: "\u{1F600}", suffix: "" } });
    expect(res.status).toBe(201);
    expect(mockCreateComment.mock.calls[0][0].anchor.quote).toBe(quote);
    expect(mockCreateComment.mock.calls[0][0].anchor.prefix).toBe("\u{1F600}");
    const activity = mockRecordActivity.mock.calls.at(-1)?.[0];
    expect(activity.detail.quote).toBe("a".repeat(199));
  });
});
