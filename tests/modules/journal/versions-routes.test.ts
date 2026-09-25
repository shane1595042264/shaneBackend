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
import { VersionConflictError } from "@/modules/journal/versions-repo";
import { VersionNotFoundError } from "@/modules/shared/domain-errors";

beforeEach(() => vi.clearAllMocks());

const app = new Hono().route("/api/journal", journalRoutes);

describe("PATCH /api/journal/entries/:date", () => {
  it("returns 405 — entries are append-only", async () => {
    const res = await app.request("/api/journal/entries/2026-04-29", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "X-Test-User": "u1", "If-Match": "1" },
      body: JSON.stringify({ content: "new" }),
    });
    expect(res.status).toBe(405);
    expect(mockAppend).not.toHaveBeenCalled();
  });

  it("returns 405 even without auth (method itself is disabled)", async () => {
    const res = await app.request("/api/journal/entries/2026-04-29", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "x" }),
    });
    expect(res.status).toBe(405);
  });
});

describe("GET /api/journal/entries/:date/versions", () => {
  it("returns version list ordered desc with the default page size", async () => {
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
    expect(mockListV).toHaveBeenCalledWith("e1", { limit: 50, cursor: undefined });
    // Partial page — nothing more to fetch.
    expect(body.nextCursor).toBeNull();
  });

  it("threads limit + cursor through and returns the last versionNum as nextCursor", async () => {
    mockGetByDate.mockResolvedValue({ entry: { id: "e1" }, currentVersion: { versionNum: 9 } });
    mockListV.mockResolvedValue([
      { id: "v9", versionNum: 9 },
      { id: "v8", versionNum: 8 },
    ]);
    const res = await app.request("/api/journal/entries/2026-04-29/versions?limit=2&cursor=10");
    expect(res.status).toBe(200);
    expect(mockListV).toHaveBeenCalledWith("e1", { limit: 2, cursor: 10 });
    expect((await res.json()).nextCursor).toBe(8);
  });

  it("returns nextCursor null on a full page that ends at v1", async () => {
    mockGetByDate.mockResolvedValue({ entry: { id: "e1" }, currentVersion: { versionNum: 2 } });
    mockListV.mockResolvedValue([
      { id: "v2", versionNum: 2 },
      { id: "v1", versionNum: 1 },
    ]);
    const res = await app.request("/api/journal/entries/2026-04-29/versions?limit=2");
    expect((await res.json()).nextCursor).toBeNull();
  });

  it("rejects a non-numeric cursor with 400 instead of reaching the query", async () => {
    mockGetByDate.mockResolvedValue({ entry: { id: "e1" }, currentVersion: { versionNum: 1 } });
    const res = await app.request("/api/journal/entries/2026-04-29/versions?cursor=abc");
    expect(res.status).toBe(400);
    expect(mockListV).not.toHaveBeenCalled();
  });

  it("rejects a cursor past the int4 ceiling with 400 instead of reaching the query", async () => {
    // SHAN-529: version_num is an int4 column. Before the bound, 3000000000
    // passed z.coerce.number().int().min(1) and Postgres threw "value
    // \"3000000000\" is out of range for type integer" — a 500 for a bad request.
    mockGetByDate.mockResolvedValue({ entry: { id: "e1" }, currentVersion: { versionNum: 1 } });
    const res = await app.request("/api/journal/entries/2026-04-29/versions?cursor=3000000000");
    expect(res.status).toBe(400);
    expect(mockListV).not.toHaveBeenCalled();
  });

  it("still accepts a cursor at the int4 ceiling", async () => {
    mockGetByDate.mockResolvedValue({ entry: { id: "e1" }, currentVersion: { versionNum: 1 } });
    mockListV.mockResolvedValue([]);
    const res = await app.request("/api/journal/entries/2026-04-29/versions?cursor=2147483647");
    expect(res.status).toBe(200);
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

  it("rejects a :num past the int4 ceiling with 400, not a 500 from Postgres", async () => {
    const res = await app.request("/api/journal/entries/2026-04-29/versions/3000000000");
    expect(res.status).toBe(400);
    expect(mockGetV).not.toHaveBeenCalled();
  });

  it("rejects calendar-invalid :date (2026-02-30) with 400 before the entry lookup", async () => {
    const res = await app.request("/api/journal/entries/2026-02-30/versions/1");
    expect(res.status).toBe(400);
    expect(mockGetByDate).not.toHaveBeenCalled();
    expect(mockGetV).not.toHaveBeenCalled();
  });

  it("rejects month 13 :date (2026-13-01) with 400 before the entry lookup", async () => {
    const res = await app.request("/api/journal/entries/2026-13-01/versions/1");
    expect(res.status).toBe(400);
    expect(mockGetByDate).not.toHaveBeenCalled();
    expect(mockGetV).not.toHaveBeenCalled();
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

  // SHAN-530: the mirror of blog's "404s rather than 500s when the target
  // version does not exist". Asking for version 99 of a six-version entry used
  // to reach the global handler and come back as a 500, which a client cannot
  // tell apart from the backend being down.
  it("404s rather than 500s when the target version does not exist", async () => {
    mockGetByDate.mockResolvedValue({ entry: { authorId: "u1", id: "e1" }, currentVersion: { versionNum: 5 } });
    mockRevert.mockRejectedValue(new VersionNotFoundError());
    const res = await app.request("/api/journal/entries/2026-04-29/revert", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Test-User": "u1", "If-Match": "5" },
      body: JSON.stringify({ target_version_num: 99 }),
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Target version not found" });
  });

  it("returns 400 when target_version_num is past the int4 ceiling (SHAN-529)", async () => {
    mockGetByDate.mockResolvedValue({ entry: { authorId: "u1", id: "e1" }, currentVersion: { versionNum: 5 } });
    const res = await app.request("/api/journal/entries/2026-04-29/revert", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Test-User": "u1", "If-Match": "5" },
      body: JSON.stringify({ target_version_num: 3_000_000_000 }),
    });
    expect(res.status).toBe(400);
    expect(mockRevert).not.toHaveBeenCalled();
  });

  it("returns 428 if If-Match missing", async () => {
    const res = await app.request("/api/journal/entries/2026-04-29/revert", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Test-User": "u1" },
      body: JSON.stringify({ target_version_num: 2 }),
    });
    expect(res.status).toBe(428);
  });

  it("returns 400 when If-Match is malformed (not a number)", async () => {
    const res = await app.request("/api/journal/entries/2026-04-29/revert", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Test-User": "u1", "If-Match": "not-a-number" },
      body: JSON.stringify({ target_version_num: 2 }),
    });
    expect(res.status).toBe(400);
    expect(mockRevert).not.toHaveBeenCalled();
  });
});

// SHAN-489: X-If-Match is the proxy-safe alias for If-Match. A browser's real
// If-Match never survives the Vercel rewrite — the edge compares it against our
// weak ETag, fails the strong-comparison rule and answers 412 AFTER the revert
// has committed. Both spellings have to work: PAT callers hit Railway directly
// and keep using the documented header.
describe("POST /api/journal/entries/:date/revert — X-If-Match alias", () => {
  it("accepts X-If-Match", async () => {
    mockGetByDate.mockResolvedValue({ entry: { authorId: "u1", id: "e1" }, currentVersion: { versionNum: 5 } });
    mockRevert.mockResolvedValue({ id: "v6", versionNum: 6 });
    const res = await app.request("/api/journal/entries/2026-04-29/revert", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Test-User": "u1", "X-If-Match": "5" },
      body: JSON.stringify({ target_version_num: 2 }),
    });
    expect(res.status).toBe(200);
    expect(mockRevert).toHaveBeenCalledWith("e1", 2, "u1", 5);
  });

  it("prefers If-Match when both are sent", async () => {
    mockGetByDate.mockResolvedValue({ entry: { authorId: "u1", id: "e1" }, currentVersion: { versionNum: 5 } });
    mockRevert.mockResolvedValue({ id: "v6", versionNum: 6 });
    await app.request("/api/journal/entries/2026-04-29/revert", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Test-User": "u1",
        "If-Match": "5",
        "X-If-Match": "2",
      },
      body: JSON.stringify({ target_version_num: 2 }),
    });
    expect(mockRevert).toHaveBeenCalledWith("e1", 2, "u1", 5);
  });

  it("returns 400 when X-If-Match is malformed", async () => {
    const res = await app.request("/api/journal/entries/2026-04-29/revert", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Test-User": "u1", "X-If-Match": "nope" },
      body: JSON.stringify({ target_version_num: 2 }),
    });
    expect(res.status).toBe(400);
    expect(mockRevert).not.toHaveBeenCalled();
  });
});
