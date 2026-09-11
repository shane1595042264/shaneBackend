// tests/modules/journal/activity-routes.test.ts — SHAN-483
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

const { mockGetByDate, mockListActivity, mockListForEntry, mockRecordActivity, mockMembership } =
  vi.hoisted(() => ({
    mockGetByDate: vi.fn(),
    mockListActivity: vi.fn(),
    mockListForEntry: vi.fn(),
    mockRecordActivity: vi.fn(),
    mockMembership: vi.fn(),
  }));

vi.mock("@/modules/journal/activity-repo", () => ({
  recordActivity: mockRecordActivity,
  listActivity: mockListActivity,
  listActivityForEntry: mockListForEntry,
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
vi.mock("@/modules/journal/appends-repo", () => ({
  createAppend: vi.fn(),
  listAppendsForEntry: vi.fn(),
  updateAppend: vi.fn(),
  softDeleteAppend: vi.fn(),
}));
// Membership is configurable here because one of the assertions below is that
// the feed sits BEHIND the invite-only gate rather than being world-public.
vi.mock("@/modules/journal/access-middleware", () => ({
  requireJournalMembership: (c: any, next: any) => mockMembership(c, next),
}));
vi.mock("@/modules/auth/middleware", () => ({
  optionalAuth: async (c: any, next: any) => {
    c.set("userId", c.req.header("X-Test-User") ?? null);
    c.set("tokenScopes", null);
    c.set("tokenId", null);
    await next();
  },
  requireAuth: async (c: any, next: any) => {
    const u = c.req.header("X-Test-User");
    if (!u) return c.json({ error: "auth" }, 401);
    c.set("userId", u);
    c.set("tokenScopes", null);
    c.set("tokenId", null);
    await next();
  },
  requireScope: () => async (_c: any, next: any) => { await next(); },
}));

import { journalRoutes } from "@/modules/journal/routes";

beforeEach(() => {
  vi.clearAllMocks();
  mockMembership.mockImplementation(async (_c: any, next: any) => { await next(); });
});

const app = new Hono().route("/api/journal", journalRoutes);

const row = (over: Record<string, unknown> = {}) => ({
  id: "act1",
  entryId: "e1",
  entryDate: "2026-09-11",
  action: "append.delete",
  targetType: "append",
  targetId: "a1",
  actorId: "u1",
  detail: null,
  createdAt: new Date("2026-09-11T10:00:00Z"),
  actor: { id: "u1", name: "Shane", avatarUrl: null, agent: null },
  ...over,
});

describe("GET /api/journal/activity", () => {
  it("returns the site-wide feed with actor attribution", async () => {
    mockListActivity.mockResolvedValue([
      row({ actor: { id: "u1", name: "Shane", avatarUrl: null, agent: { tokenId: "t1", name: "jira-worker" } } }),
    ]);

    const res = await app.request("/api/journal/activity", {
      headers: { "X-Test-User": "u1" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.activity).toHaveLength(1);
    expect(body.activity[0].action).toBe("append.delete");
    expect(body.activity[0].actor.name).toBe("Shane");
    expect(body.activity[0].actor.agent.name).toBe("jira-worker");
  });

  // SHAN-475 put requireJournalMembership on every journal read. The feed is
  // transparent WITHIN the journal, not world-public — verify the gate runs.
  it("is behind the invite-only membership gate", async () => {
    mockMembership.mockImplementation(async (c: any) => c.json({ error: "Not a member" }, 403));
    const res = await app.request("/api/journal/activity");
    expect(res.status).toBe(403);
    expect(mockListActivity).not.toHaveBeenCalled();
  });

  it("emits nextCursor only when the page is full", async () => {
    mockListActivity.mockResolvedValue([row()]);
    const partial = await (
      await app.request("/api/journal/activity?limit=50", { headers: { "X-Test-User": "u1" } })
    ).json();
    expect(partial.nextCursor).toBeNull();

    mockListActivity.mockResolvedValue([row(), row({ id: "act2" })]);
    const full = await (
      await app.request("/api/journal/activity?limit=2", { headers: { "X-Test-User": "u1" } })
    ).json();
    expect(full.nextCursor).toBe("2026-09-11T10:00:00.000Z");
  });

  it("passes a cursor through as a Date", async () => {
    mockListActivity.mockResolvedValue([]);
    await app.request("/api/journal/activity?cursor=2026-09-11T10:00:00.000Z", {
      headers: { "X-Test-User": "u1" },
    });
    expect(mockListActivity).toHaveBeenCalledWith({
      limit: 50,
      cursor: new Date("2026-09-11T10:00:00.000Z"),
    });
  });

  // The activity cursor is a timestamp, NOT an isoDate like the entries
  // cursor (SHAN-373). A malformed one must 400, not reach the column.
  it("400s on a malformed cursor", async () => {
    const res = await app.request("/api/journal/activity?cursor=2026-09-11", {
      headers: { "X-Test-User": "u1" },
    });
    expect(res.status).toBe(400);
    expect(mockListActivity).not.toHaveBeenCalled();
  });

  it("400s on an out-of-range limit", async () => {
    const res = await app.request("/api/journal/activity?limit=500", {
      headers: { "X-Test-User": "u1" },
    });
    expect(res.status).toBe(400);
  });
});

describe("GET /api/journal/entries/:date/activity", () => {
  it("returns the per-entry feed", async () => {
    mockGetByDate.mockResolvedValue({ entry: { id: "e1" } });
    mockListForEntry.mockResolvedValue([row()]);

    const res = await app.request("/api/journal/entries/2026-09-11/activity", {
      headers: { "X-Test-User": "u1" },
    });
    expect(res.status).toBe(200);
    expect((await res.json()).activity).toHaveLength(1);
    expect(mockListForEntry).toHaveBeenCalledWith("e1", { limit: 50, cursor: undefined });
  });

  it("404s when the entry is missing", async () => {
    mockGetByDate.mockResolvedValue(null);
    const res = await app.request("/api/journal/entries/2026-09-11/activity", {
      headers: { "X-Test-User": "u1" },
    });
    expect(res.status).toBe(404);
    expect(mockListForEntry).not.toHaveBeenCalled();
  });

  it("400s on a malformed date", async () => {
    const res = await app.request("/api/journal/entries/not-a-date/activity", {
      headers: { "X-Test-User": "u1" },
    });
    expect(res.status).toBe(400);
  });
});
