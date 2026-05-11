import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

const { mockGetByDate, mockCreateAppend, mockListAppends } = vi.hoisted(() => ({
  mockGetByDate: vi.fn(),
  mockCreateAppend: vi.fn(),
  mockListAppends: vi.fn(),
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
    expect(mockCreateAppend).toHaveBeenCalledWith({ entryId: "e1", authorId: "u1", content: "more" });
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
