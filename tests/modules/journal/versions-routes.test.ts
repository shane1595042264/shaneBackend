// tests/modules/journal/versions-routes.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

const { mockGetByDate, mockAppend, mockListV, mockGetV, mockRevert } = vi.hoisted(() => ({
  mockGetByDate: vi.fn(),
  mockAppend: vi.fn(),
  mockListV: vi.fn(),
  mockGetV: vi.fn(),
  mockRevert: vi.fn(),
}));

vi.mock("@/modules/journal/entries-repo", () => ({
  getEntryByDate: mockGetByDate,
  listEntries: vi.fn(),
  createEntry: vi.fn(),
  softDeleteEntry: vi.fn(),
  hashContent: (s: string) => s,
}));
vi.mock("@/modules/journal/versions-repo", () => ({
  appendDirectVersion: mockAppend,
  listVersions: mockListV,
  getVersion: mockGetV,
  revertToVersion: mockRevert,
  VersionConflictError: class extends Error {
    constructor(public currentVersionNum: number) { super("VersionConflict"); this.name = "VersionConflict"; }
  },
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
import { VersionConflictError } from "@/modules/journal/versions-repo";

beforeEach(() => vi.clearAllMocks());

const app = new Hono().route("/api/journal", journalRoutes);

describe("PATCH /api/journal/entries/:date", () => {
  it("creates new version when author edits with matching If-Match", async () => {
    mockGetByDate.mockResolvedValue({ entry: { authorId: "u1", id: "e1" }, currentVersion: { versionNum: 3 } });
    mockAppend.mockResolvedValue({ id: "v4", versionNum: 4 });
    const res = await app.request("/api/journal/entries/2026-04-29", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "X-Test-User": "u1", "If-Match": "3" },
      body: JSON.stringify({ content: "new" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.versionNum).toBe(4);
    expect(mockAppend).toHaveBeenCalledWith(expect.objectContaining({ entryId: "e1", editorId: "u1", content: "new", ifMatchVersionNum: 3 }));
  });

  it("returns 403 when non-author tries direct edit", async () => {
    mockGetByDate.mockResolvedValue({ entry: { authorId: "other", id: "e1" }, currentVersion: { versionNum: 1 } });
    const res = await app.request("/api/journal/entries/2026-04-29", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "X-Test-User": "u1", "If-Match": "1" },
      body: JSON.stringify({ content: "x" }),
    });
    expect(res.status).toBe(403);
  });

  it("returns 409 with currentVersionNum on If-Match mismatch", async () => {
    mockGetByDate.mockResolvedValue({ entry: { authorId: "u1", id: "e1" }, currentVersion: { versionNum: 5 } });
    mockAppend.mockRejectedValue(new VersionConflictError(5));
    const res = await app.request("/api/journal/entries/2026-04-29", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "X-Test-User": "u1", "If-Match": "3" },
      body: JSON.stringify({ content: "x" }),
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.currentVersionNum).toBe(5);
  });

  it("returns 428 if If-Match header missing", async () => {
    const res = await app.request("/api/journal/entries/2026-04-29", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "X-Test-User": "u1" },
      body: JSON.stringify({ content: "x" }),
    });
    expect(res.status).toBe(428);
  });

  it("returns 401 without auth", async () => {
    const res = await app.request("/api/journal/entries/2026-04-29", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "If-Match": "1" },
      body: JSON.stringify({ content: "x" }),
    });
    expect(res.status).toBe(401);
  });

  it("returns 404 when entry doesn't exist", async () => {
    mockGetByDate.mockResolvedValue(null);
    const res = await app.request("/api/journal/entries/2026-04-29", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "X-Test-User": "u1", "If-Match": "1" },
      body: JSON.stringify({ content: "x" }),
    });
    expect(res.status).toBe(404);
  });
});

describe("GET /api/journal/entries/:date/versions", () => {
  it("returns version list ordered desc", async () => {
    mockGetByDate.mockResolvedValue({ entry: { id: "e1" }, currentVersion: { versionNum: 3 } });
    mockListV.mockResolvedValue([
      { id: "v3", versionNum: 3 },
      { id: "v2", versionNum: 2 },
      { id: "v1", versionNum: 1 },
    ]);
    const res = await app.request("/api/journal/entries/2026-04-29/versions");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.versions).toHaveLength(3);
    expect(mockListV).toHaveBeenCalledWith("e1");
  });

  it("returns 404 when entry doesn't exist", async () => {
    mockGetByDate.mockResolvedValue(null);
    const res = await app.request("/api/journal/entries/2026-04-29/versions");
    expect(res.status).toBe(404);
  });
});

describe("GET /api/journal/entries/:date/versions/:num", () => {
  it("returns specific version", async () => {
    mockGetByDate.mockResolvedValue({ entry: { id: "e1" }, currentVersion: {} });
    mockGetV.mockResolvedValue({ id: "v2", versionNum: 2, content: "old" });
    const res = await app.request("/api/journal/entries/2026-04-29/versions/2");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.version.versionNum).toBe(2);
  });

  it("returns 404 when version doesn't exist", async () => {
    mockGetByDate.mockResolvedValue({ entry: { id: "e1" }, currentVersion: {} });
    mockGetV.mockResolvedValue(null);
    const res = await app.request("/api/journal/entries/2026-04-29/versions/99");
    expect(res.status).toBe(404);
  });

  it("rejects non-numeric :num with 400", async () => {
    const res = await app.request("/api/journal/entries/2026-04-29/versions/abc");
    expect(res.status).toBe(400);
  });
});

describe("POST /api/journal/entries/:date/revert", () => {
  it("creates new version copying target content", async () => {
    mockGetByDate.mockResolvedValue({ entry: { authorId: "u1", id: "e1" }, currentVersion: { versionNum: 5 } });
    mockRevert.mockResolvedValue({ id: "v6", versionNum: 6 });
    const res = await app.request("/api/journal/entries/2026-04-29/revert", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Test-User": "u1", "If-Match": "5" },
      body: JSON.stringify({ target_version_num: 2 }),
    });
    expect(res.status).toBe(200);
    expect(mockRevert).toHaveBeenCalledWith("e1", 2, "u1", 5);
  });

  it("returns 403 when non-author tries to revert", async () => {
    mockGetByDate.mockResolvedValue({ entry: { authorId: "other", id: "e1" }, currentVersion: { versionNum: 5 } });
    const res = await app.request("/api/journal/entries/2026-04-29/revert", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Test-User": "u1", "If-Match": "5" },
      body: JSON.stringify({ target_version_num: 2 }),
    });
    expect(res.status).toBe(403);
  });

  it("returns 409 on If-Match mismatch", async () => {
    mockGetByDate.mockResolvedValue({ entry: { authorId: "u1", id: "e1" }, currentVersion: { versionNum: 5 } });
    mockRevert.mockRejectedValue(new VersionConflictError(5));
    const res = await app.request("/api/journal/entries/2026-04-29/revert", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Test-User": "u1", "If-Match": "3" },
      body: JSON.stringify({ target_version_num: 2 }),
    });
    expect(res.status).toBe(409);
  });

  it("returns 428 if If-Match missing", async () => {
    const res = await app.request("/api/journal/entries/2026-04-29/revert", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Test-User": "u1" },
      body: JSON.stringify({ target_version_num: 2 }),
    });
    expect(res.status).toBe(428);
  });
});
