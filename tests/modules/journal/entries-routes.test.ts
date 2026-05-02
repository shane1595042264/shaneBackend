// tests/modules/journal/entries-routes.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

const { mockListEntries, mockGetByDate, mockCreateEntry, mockSoftDelete } = vi.hoisted(() => ({
  mockListEntries: vi.fn(),
  mockGetByDate: vi.fn(),
  mockCreateEntry: vi.fn(),
  mockSoftDelete: vi.fn(),
}));

vi.mock("@/modules/journal/entries-repo", () => ({
  listEntries: mockListEntries,
  getEntryByDate: mockGetByDate,
  createEntry: mockCreateEntry,
  softDeleteEntry: mockSoftDelete,
  hashContent: (s: string) => "hash-" + s.length,
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

describe("GET /api/journal/entries", () => {
  it("returns the list with cursor pagination metadata", async () => {
    mockListEntries.mockResolvedValue([
      { id: "e1", date: "2026-04-29" },
      { id: "e2", date: "2026-04-28" },
    ]);
    const res = await app.request("/api/journal/entries?limit=2");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.entries).toHaveLength(2);
    expect(body.nextCursor).toBe("2026-04-28");
  });

  it("returns null cursor when result is shorter than limit", async () => {
    mockListEntries.mockResolvedValue([{ id: "e1", date: "2026-04-29" }]);
    const res = await app.request("/api/journal/entries?limit=50");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.nextCursor).toBeNull();
  });

  it("forwards from/to/cursor query params to the repo", async () => {
    mockListEntries.mockResolvedValue([]);
    await app.request("/api/journal/entries?from=2026-04-01&to=2026-04-30&cursor=2026-05-01&limit=10");
    expect(mockListEntries).toHaveBeenCalledWith(expect.objectContaining({
      from: "2026-04-01",
      to: "2026-04-30",
      cursorDate: "2026-05-01",
      limit: 10,
    }));
  });
});

describe("GET /api/journal/entries/:date", () => {
  it("returns the entry + content + currentVersionNum", async () => {
    mockGetByDate.mockResolvedValue({
      entry: { id: "e1", date: "2026-04-29", authorId: "u1", editCount: 1 },
      currentVersion: { id: "v1", versionNum: 1, content: "hello" },
    });
    const res = await app.request("/api/journal/entries/2026-04-29");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.entry.date).toBe("2026-04-29");
    expect(body.content).toBe("hello");
    expect(body.currentVersionNum).toBe(1);
  });

  it("returns 404 when missing", async () => {
    mockGetByDate.mockResolvedValue(null);
    const res = await app.request("/api/journal/entries/2026-04-29");
    expect(res.status).toBe(404);
  });

  it("rejects malformed date with 400", async () => {
    const res = await app.request("/api/journal/entries/not-a-date");
    expect(res.status).toBe(400);
  });
});

describe("POST /api/journal/entries", () => {
  it("creates a new entry when date unclaimed", async () => {
    mockCreateEntry.mockResolvedValue({
      entry: { id: "e1", date: "2026-04-29", authorId: "u1" },
      version: { id: "v1", versionNum: 1 },
    });
    const res = await app.request("/api/journal/entries", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Test-User": "u1" },
      body: JSON.stringify({ date: "2026-04-29", content: "hi" }),
    });
    expect(res.status).toBe(201);
    expect(mockCreateEntry).toHaveBeenCalledWith({ date: "2026-04-29", authorId: "u1", content: "hi" });
  });

  it("returns 409 on unique violation (date already claimed)", async () => {
    mockCreateEntry.mockRejectedValue({ code: "23505" });
    const res = await app.request("/api/journal/entries", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Test-User": "u1" },
      body: JSON.stringify({ date: "2026-04-29", content: "hi" }),
    });
    expect(res.status).toBe(409);
  });

  it("returns 409 when error.cause.code is 23505", async () => {
    mockCreateEntry.mockRejectedValue({ cause: { code: "23505" } });
    const res = await app.request("/api/journal/entries", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Test-User": "u1" },
      body: JSON.stringify({ date: "2026-04-29", content: "hi" }),
    });
    expect(res.status).toBe(409);
  });

  it("returns 401 without auth", async () => {
    const res = await app.request("/api/journal/entries", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ date: "2026-04-29", content: "hi" }),
    });
    expect(res.status).toBe(401);
  });

  it("returns 400 on missing fields", async () => {
    const res = await app.request("/api/journal/entries", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Test-User": "u1" },
      body: JSON.stringify({ date: "2026-04-29" }), // missing content
    });
    expect(res.status).toBe(400);
  });
});

describe("DELETE /api/journal/entries/:date", () => {
  it("returns 204 when soft-delete succeeds (caller is author)", async () => {
    mockSoftDelete.mockResolvedValue(true);
    const res = await app.request("/api/journal/entries/2026-04-29", {
      method: "DELETE",
      headers: { "X-Test-User": "u1" },
    });
    expect(res.status).toBe(204);
    expect(mockSoftDelete).toHaveBeenCalledWith("2026-04-29", "u1");
  });

  it("returns 404 when caller isn't the author or entry missing", async () => {
    mockSoftDelete.mockResolvedValue(false);
    const res = await app.request("/api/journal/entries/2026-04-29", {
      method: "DELETE",
      headers: { "X-Test-User": "u1" },
    });
    expect(res.status).toBe(404);
  });

  it("returns 401 without auth", async () => {
    const res = await app.request("/api/journal/entries/2026-04-29", {
      method: "DELETE",
    });
    expect(res.status).toBe(401);
  });
});
