import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

const {
  mockGetByDate,
  mockCreateAppend,
  mockListAppends,
  mockUpdateAppend,
  mockSoftDeleteAppend,
  mockRecordActivity,
} = vi.hoisted(() => ({
  mockGetByDate: vi.fn(),
  mockCreateAppend: vi.fn(),
  mockListAppends: vi.fn(),
  mockUpdateAppend: vi.fn(),
  mockSoftDeleteAppend: vi.fn(),
  mockRecordActivity: vi.fn(),
}));

// SHAN-483: stub the audit trail so these assertions stay about the append
// routes. recordActivity swallows its own errors by design, so an unmocked
// one would pass silently while trying to reach a real DB.
vi.mock("@/modules/journal/activity-repo", () => ({
  recordActivity: mockRecordActivity,
  listActivity: vi.fn(),
  listActivityForEntry: vi.fn(),
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
  createAppend: mockCreateAppend,
  listAppendsForEntry: mockListAppends,
  updateAppend: mockUpdateAppend,
  softDeleteAppend: mockSoftDeleteAppend,
}));
// SHAN-475: every journal route now runs requireJournalMembership. These
// suites are about the routes, not the gate, so let everyone through here;
// the gate itself is covered in access-middleware.test.ts.
vi.mock("@/modules/journal/access-middleware", () => ({
  requireJournalMembership: async (_c: any, next: any) => { await next(); },
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

import { journalRoutes } from "@/modules/journal/routes";

beforeEach(() => vi.clearAllMocks());

const app = new Hono().route("/api/journal", journalRoutes);

describe("POST /api/journal/entries/:date/appends", () => {
  it("creates an append when the author posts", async () => {
    mockGetByDate.mockResolvedValue({ entry: { id: "e1", authorId: "u1" } });
    const created = { id: "a1", entryId: "e1", authorId: "u1", content: "more", createdAt: new Date().toISOString() };
    mockCreateAppend.mockResolvedValue(created);

    const res = await app.request("/api/journal/entries/2026-05-11/appends", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Test-User": "u1" },
      body: JSON.stringify({ content: "more" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.append.id).toBe("a1");
    expect(mockCreateAppend).toHaveBeenCalledWith({
      entryId: "e1",
      authorId: "u1",
      authorTimezone: "America/Chicago",
      content: "more",
    });
  });

  it("rejects non-author with 403", async () => {
    mockGetByDate.mockResolvedValue({ entry: { id: "e1", authorId: "someone-else" } });
    const res = await app.request("/api/journal/entries/2026-05-11/appends", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Test-User": "u1" },
      body: JSON.stringify({ content: "x" }),
    });
    expect(res.status).toBe(403);
    expect(mockCreateAppend).not.toHaveBeenCalled();
  });

  it("returns 404 when entry missing", async () => {
    mockGetByDate.mockResolvedValue(null);
    const res = await app.request("/api/journal/entries/2026-05-11/appends", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Test-User": "u1" },
      body: JSON.stringify({ content: "x" }),
    });
    expect(res.status).toBe(404);
  });

  it("returns 401 without auth", async () => {
    const res = await app.request("/api/journal/entries/2026-05-11/appends", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "x" }),
    });
    expect(res.status).toBe(401);
  });

  it("rejects empty content with 400", async () => {
    const res = await app.request("/api/journal/entries/2026-05-11/appends", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Test-User": "u1" },
      body: JSON.stringify({ content: "" }),
    });
    expect(res.status).toBe(400);
  });

  // SHAN-431: whitespace-only append 400s instead of persisting a blank append.
  it("rejects a whitespace-only content with 400 (SHAN-431)", async () => {
    mockGetByDate.mockResolvedValue({ entry: { id: "e1", authorId: "u1" } });
    const res = await app.request("/api/journal/entries/2026-05-11/appends", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Test-User": "u1" },
      body: JSON.stringify({ content: "   \n  " }),
    });
    expect(res.status).toBe(400);
    expect(mockCreateAppend).not.toHaveBeenCalled();
  });

  it("trims incidental padding from append content before persisting (SHAN-431)", async () => {
    mockGetByDate.mockResolvedValue({ entry: { id: "e1", authorId: "u1" } });
    mockCreateAppend.mockResolvedValue({ id: "a1", entryId: "e1", authorId: "u1", content: "more", createdAt: new Date().toISOString() });
    const res = await app.request("/api/journal/entries/2026-05-11/appends", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Test-User": "u1" },
      body: JSON.stringify({ content: "  more  " }),
    });
    expect(res.status).toBe(201);
    expect(mockCreateAppend).toHaveBeenCalledWith(expect.objectContaining({ content: "more" }));
  });
});

describe("GET /api/journal/entries/:date/appends", () => {
  it("returns the append list", async () => {
    mockGetByDate.mockResolvedValue({ entry: { id: "e1" } });
    mockListAppends.mockResolvedValue([
      { id: "a1", content: "one", createdAt: "2026-05-11T08:00:00Z" },
      { id: "a2", content: "two", createdAt: "2026-05-11T09:00:00Z" },
    ]);
    const res = await app.request("/api/journal/entries/2026-05-11/appends");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.appends).toHaveLength(2);
    expect(mockListAppends).toHaveBeenCalledWith("e1");
  });

  it("returns 404 when entry missing", async () => {
    mockGetByDate.mockResolvedValue(null);
    const res = await app.request("/api/journal/entries/2026-05-11/appends");
    expect(res.status).toBe(404);
  });
});

describe("GET /api/journal/entries/:date includes appends", () => {
  it("returns the entry payload with appends list", async () => {
    mockGetByDate.mockResolvedValue({
      entry: { id: "e1", date: "2026-05-11", authorId: "u1" },
      currentVersion: { content: "first post", versionNum: 1 },
      author: { id: "u1", name: "Alice", avatarUrl: null },
    });
    mockListAppends.mockResolvedValue([
      { id: "a1", entryId: "e1", authorId: "u1", content: "later thought", createdAt: "2026-05-11T10:00:00Z", author: { id: "u1", name: "Alice", avatarUrl: null } },
    ]);
    const res = await app.request("/api/journal/entries/2026-05-11");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.content).toBe("first post");
    expect(body.appends).toHaveLength(1);
    expect(body.appends[0].content).toBe("later thought");
  });
});

// SHAN-483: the reported bug was "an agent added double content and there is
// no way to delete the redundant part". These two routes are the fix.
const AID = "11111111-1111-4111-8111-111111111111";

describe("PATCH /api/journal/entries/:date/appends/:id", () => {
  it("edits the author's own append and records an audit row", async () => {
    mockGetByDate.mockResolvedValue({ entry: { id: "e1", authorId: "u1" } });
    mockUpdateAppend.mockResolvedValue({ id: AID, entryId: "e1", content: "fixed" });

    const res = await app.request(`/api/journal/entries/2026-05-11/appends/${AID}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "X-Test-User": "u1" },
      body: JSON.stringify({ content: "fixed" }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).append.content).toBe("fixed");
    expect(mockUpdateAppend).toHaveBeenCalledWith({
      id: AID,
      entryId: "e1",
      authorId: "u1",
      content: "fixed",
    });
    expect(mockRecordActivity).toHaveBeenCalledWith(
      expect.objectContaining({ action: "append.update", targetType: "append", targetId: AID })
    );
  });

  it("404s when the append is not the caller's, and logs nothing", async () => {
    mockGetByDate.mockResolvedValue({ entry: { id: "e1", authorId: "u1" } });
    mockUpdateAppend.mockResolvedValue(null);

    const res = await app.request(`/api/journal/entries/2026-05-11/appends/${AID}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "X-Test-User": "u2" },
      body: JSON.stringify({ content: "fixed" }),
    });
    expect(res.status).toBe(404);
    expect(mockRecordActivity).not.toHaveBeenCalled();
  });

  it("404s when the entry is missing", async () => {
    mockGetByDate.mockResolvedValue(null);
    const res = await app.request(`/api/journal/entries/2026-05-11/appends/${AID}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "X-Test-User": "u1" },
      body: JSON.stringify({ content: "fixed" }),
    });
    expect(res.status).toBe(404);
    expect(mockUpdateAppend).not.toHaveBeenCalled();
  });

  it("400s on a malformed append id rather than reaching the uuid column", async () => {
    const res = await app.request("/api/journal/entries/2026-05-11/appends/not-a-uuid", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "X-Test-User": "u1" },
      body: JSON.stringify({ content: "fixed" }),
    });
    expect(res.status).toBe(400);
  });

  it("400s on whitespace-only content", async () => {
    mockGetByDate.mockResolvedValue({ entry: { id: "e1", authorId: "u1" } });
    const res = await app.request(`/api/journal/entries/2026-05-11/appends/${AID}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "X-Test-User": "u1" },
      body: JSON.stringify({ content: "   \n " }),
    });
    expect(res.status).toBe(400);
    expect(mockUpdateAppend).not.toHaveBeenCalled();
  });

  it("401s without auth", async () => {
    const res = await app.request(`/api/journal/entries/2026-05-11/appends/${AID}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "fixed" }),
    });
    expect(res.status).toBe(401);
  });
});

describe("DELETE /api/journal/entries/:date/appends/:id", () => {
  it("soft-deletes the author's own append and records an audit row", async () => {
    mockGetByDate.mockResolvedValue({ entry: { id: "e1", authorId: "u1" } });
    mockSoftDeleteAppend.mockResolvedValue({ id: AID, entryId: "e1" });

    const res = await app.request(`/api/journal/entries/2026-05-11/appends/${AID}`, {
      method: "DELETE",
      headers: { "X-Test-User": "u1" },
    });
    expect(res.status).toBe(204);
    expect(mockSoftDeleteAppend).toHaveBeenCalledWith({
      id: AID,
      entryId: "e1",
      authorId: "u1",
    });
    expect(mockRecordActivity).toHaveBeenCalledWith(
      expect.objectContaining({ action: "append.delete", targetType: "append", targetId: AID })
    );
  });

  it("404s on a repeat delete (already soft-deleted) instead of double-logging", async () => {
    mockGetByDate.mockResolvedValue({ entry: { id: "e1", authorId: "u1" } });
    mockSoftDeleteAppend.mockResolvedValue(null);

    const res = await app.request(`/api/journal/entries/2026-05-11/appends/${AID}`, {
      method: "DELETE",
      headers: { "X-Test-User": "u1" },
    });
    expect(res.status).toBe(404);
    expect(mockRecordActivity).not.toHaveBeenCalled();
  });

  it("401s without auth", async () => {
    const res = await app.request(`/api/journal/entries/2026-05-11/appends/${AID}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(401);
  });
});
