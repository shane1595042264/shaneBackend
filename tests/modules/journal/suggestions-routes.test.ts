// tests/modules/journal/suggestions-routes.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

const {
  mockGetByDate,
  mockGetVersion,
  mockCreateSug,
  mockListSug,
  mockGetSug,
  mockInbox,
  mockApprove,
  mockReject,
  mockWithdraw,
  mockSelect,
} = vi.hoisted(() => ({
  mockGetByDate: vi.fn(),
  mockGetVersion: vi.fn(),
  mockCreateSug: vi.fn(),
  mockListSug: vi.fn(),
  mockGetSug: vi.fn(),
  mockInbox: vi.fn(),
  mockApprove: vi.fn(),
  mockReject: vi.fn(),
  mockWithdraw: vi.fn(),
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
  VersionConflictError: class extends Error {
    constructor(public currentVersionNum: number) { super("VersionConflict"); this.name = "VersionConflict"; }
  },
}));
vi.mock("@/modules/journal/suggestions-repo", () => ({
  createSuggestion: mockCreateSug,
  listSuggestionsForEntry: mockListSug,
  getSuggestion: mockGetSug,
  inboxFor: mockInbox,
  approveSuggestion: mockApprove,
  rejectSuggestion: mockReject,
  withdrawSuggestion: mockWithdraw,
}));
vi.mock("@/db/client", () => ({ db: { select: mockSelect } }));
vi.mock("@/db/schema", () => ({
  journalEntries: { id: "id_col", authorId: "author_col" },
  journalVersions: {},
  journalSuggestions: {},
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

function chain(rows: unknown[]) {
  const c: Record<string, unknown> = {};
  const t = Promise.resolve(rows);
  for (const m of ["from", "where", "limit"]) c[m] = vi.fn(() => c);
  Object.assign(c, { then: (r: any, j: any) => t.then(r, j) });
  return c;
}

import { journalRoutes } from "@/modules/journal/routes";
import { VersionConflictError } from "@/modules/journal/versions-repo";

beforeEach(() => vi.clearAllMocks());
const app = new Hono().route("/api/journal", journalRoutes);

describe("POST /api/journal/entries/:date/suggestions", () => {
  it("creates a suggestion when caller is non-author", async () => {
    mockGetByDate.mockResolvedValue({ entry: { id: "e1", authorId: "owner" }, currentVersion: { id: "v1", versionNum: 1 } });
    mockGetVersion.mockResolvedValue({ id: "v1", versionNum: 1 });
    mockCreateSug.mockResolvedValue({ id: "s1", status: "pending" });
    const res = await app.request("/api/journal/entries/2026-05-03/suggestions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Test-User": "stranger" },
      body: JSON.stringify({ base_version_num: 1, proposed_content: "edit" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.suggestion.id).toBe("s1");
    expect(mockCreateSug).toHaveBeenCalledWith(expect.objectContaining({ entryId: "e1", proposerId: "stranger", baseVersionId: "v1", proposedContent: "edit" }));
  });

  it("returns 403 when entry author tries to suggest on own entry", async () => {
    mockGetByDate.mockResolvedValue({ entry: { id: "e1", authorId: "owner" }, currentVersion: { versionNum: 1 } });
    const res = await app.request("/api/journal/entries/2026-05-03/suggestions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Test-User": "owner" },
      body: JSON.stringify({ base_version_num: 1, proposed_content: "edit" }),
    });
    expect(res.status).toBe(403);
  });

  it("returns 401 without auth", async () => {
    const res = await app.request("/api/journal/entries/2026-05-03/suggestions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ base_version_num: 1, proposed_content: "edit" }),
    });
    expect(res.status).toBe(401);
  });

  it("returns 404 when entry doesn't exist", async () => {
    mockGetByDate.mockResolvedValue(null);
    const res = await app.request("/api/journal/entries/2026-05-03/suggestions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Test-User": "stranger" },
      body: JSON.stringify({ base_version_num: 1, proposed_content: "edit" }),
    });
    expect(res.status).toBe(404);
  });

  it("returns 404 when base version doesn't exist", async () => {
    mockGetByDate.mockResolvedValue({ entry: { id: "e1", authorId: "owner" }, currentVersion: { versionNum: 1 } });
    mockGetVersion.mockResolvedValue(null);
    const res = await app.request("/api/journal/entries/2026-05-03/suggestions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Test-User": "stranger" },
      body: JSON.stringify({ base_version_num: 999, proposed_content: "edit" }),
    });
    expect(res.status).toBe(404);
  });
});

describe("GET /api/journal/entries/:date/suggestions", () => {
  it("returns the suggestion list for an entry", async () => {
    mockGetByDate.mockResolvedValue({ entry: { id: "e1" }, currentVersion: {} });
    mockListSug.mockResolvedValue([{ id: "s1" }, { id: "s2" }]);
    const res = await app.request("/api/journal/entries/2026-05-03/suggestions");
    expect(res.status).toBe(200);
    expect((await res.json()).suggestions).toHaveLength(2);
  });

  it("forwards status filter to repo", async () => {
    mockGetByDate.mockResolvedValue({ entry: { id: "e1" }, currentVersion: {} });
    mockListSug.mockResolvedValue([]);
    await app.request("/api/journal/entries/2026-05-03/suggestions?status=approved");
    expect(mockListSug).toHaveBeenCalledWith("e1", "approved");
  });

  it("returns 404 when entry missing", async () => {
    mockGetByDate.mockResolvedValue(null);
    const res = await app.request("/api/journal/entries/2026-05-03/suggestions");
    expect(res.status).toBe(404);
  });
});

describe("GET /api/journal/suggestions/:id", () => {
  it("returns the suggestion", async () => {
    mockGetSug.mockResolvedValue({ id: "s1" });
    const res = await app.request("/api/journal/suggestions/s1");
    expect(res.status).toBe(200);
  });

  it("404 when missing", async () => {
    mockGetSug.mockResolvedValue(null);
    const res = await app.request("/api/journal/suggestions/missing");
    expect(res.status).toBe(404);
  });
});

describe("PATCH /api/journal/suggestions/:id/approve", () => {
  it("approves when caller is entry author with matching If-Match", async () => {
    mockGetSug.mockResolvedValue({ id: "s1", entryId: "e1", status: "pending" });
    mockSelect.mockReturnValue(chain([{ authorId: "owner" }]));
    mockApprove.mockResolvedValue({ id: "v2", versionNum: 2 });
    const res = await app.request("/api/journal/suggestions/s1/approve", {
      method: "PATCH",
      headers: { "X-Test-User": "owner", "If-Match": "1" },
    });
    expect(res.status).toBe(200);
    expect((await res.json()).versionNum).toBe(2);
    expect(mockApprove).toHaveBeenCalledWith("s1", "owner", 1);
  });

  it("403 when caller is not the entry author", async () => {
    mockGetSug.mockResolvedValue({ id: "s1", entryId: "e1", status: "pending" });
    mockSelect.mockReturnValue(chain([{ authorId: "owner" }]));
    const res = await app.request("/api/journal/suggestions/s1/approve", {
      method: "PATCH",
      headers: { "X-Test-User": "stranger", "If-Match": "1" },
    });
    expect(res.status).toBe(403);
  });

  it("428 when If-Match header missing", async () => {
    mockGetSug.mockResolvedValue({ id: "s1", entryId: "e1", status: "pending" });
    const res = await app.request("/api/journal/suggestions/s1/approve", {
      method: "PATCH",
      headers: { "X-Test-User": "owner" },
    });
    expect(res.status).toBe(428);
  });

  it("409 on version conflict", async () => {
    mockGetSug.mockResolvedValue({ id: "s1", entryId: "e1", status: "pending" });
    mockSelect.mockReturnValue(chain([{ authorId: "owner" }]));
    mockApprove.mockRejectedValue(new VersionConflictError(5));
    const res = await app.request("/api/journal/suggestions/s1/approve", {
      method: "PATCH",
      headers: { "X-Test-User": "owner", "If-Match": "1" },
    });
    expect(res.status).toBe(409);
    expect((await res.json()).currentVersionNum).toBe(5);
  });

  it("404 when suggestion missing", async () => {
    mockGetSug.mockResolvedValue(null);
    const res = await app.request("/api/journal/suggestions/s1/approve", {
      method: "PATCH",
      headers: { "X-Test-User": "owner", "If-Match": "1" },
    });
    expect(res.status).toBe(404);
  });
});

describe("PATCH /api/journal/suggestions/:id/reject", () => {
  it("rejects when caller is entry author", async () => {
    mockGetSug.mockResolvedValue({ id: "s1", entryId: "e1", status: "pending" });
    mockSelect.mockReturnValue(chain([{ authorId: "owner" }]));
    mockReject.mockResolvedValue({ id: "s1", entryId: "e1", status: "pending" });
    const res = await app.request("/api/journal/suggestions/s1/reject", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "X-Test-User": "owner" },
      body: JSON.stringify({ reason: "not for me" }),
    });
    expect(res.status).toBe(200);
    expect(mockReject).toHaveBeenCalledWith("s1", "owner", "not for me");
  });

  it("403 when caller is not entry author", async () => {
    mockGetSug.mockResolvedValue({ id: "s1", entryId: "e1", status: "pending" });
    mockSelect.mockReturnValue(chain([{ authorId: "owner" }]));
    const res = await app.request("/api/journal/suggestions/s1/reject", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "X-Test-User": "stranger" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(403);
  });
});

describe("PATCH /api/journal/suggestions/:id/withdraw", () => {
  it("withdraws when caller is proposer", async () => {
    mockWithdraw.mockResolvedValue({ id: "s1", status: "pending" });
    const res = await app.request("/api/journal/suggestions/s1/withdraw", {
      method: "PATCH",
      headers: { "X-Test-User": "stranger" },
    });
    expect(res.status).toBe(200);
    expect(mockWithdraw).toHaveBeenCalledWith("s1", "stranger");
  });

  it("403 when withdrawSuggestion throws (non-proposer)", async () => {
    mockWithdraw.mockRejectedValue(new Error("Cannot withdraw"));
    const res = await app.request("/api/journal/suggestions/s1/withdraw", {
      method: "PATCH",
      headers: { "X-Test-User": "wrong" },
    });
    expect(res.status).toBe(403);
  });
});

describe("GET /api/journal/inbox", () => {
  it("returns pending suggestions on author's entries", async () => {
    mockInbox.mockResolvedValue([
      { suggestion: { id: "s1" }, entry: { id: "e1", date: "2026-05-03" } },
    ]);
    const res = await app.request("/api/journal/inbox", { headers: { "X-Test-User": "owner" } });
    expect(res.status).toBe(200);
    expect((await res.json()).items).toHaveLength(1);
    expect(mockInbox).toHaveBeenCalledWith("owner");
  });

  it("401 without auth", async () => {
    const res = await app.request("/api/journal/inbox");
    expect(res.status).toBe(401);
  });
});
