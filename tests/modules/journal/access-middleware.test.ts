// tests/modules/journal/access-middleware.test.ts
//
// The invite-only gate (SHAN-475). Covers the middleware in isolation plus the
// two routes that deliberately skip it, mounted through the real journalRoutes
// router so a future refactor that drops the gate from a route fails here.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

const { mockHasAccess, mockGetByDate, mockGetImageById } = vi.hoisted(() => ({
  mockHasAccess: vi.fn(),
  mockGetByDate: vi.fn(),
  mockGetImageById: vi.fn(),
}));

vi.mock("@/modules/journal/access-repo", () => ({
  hasJournalAccess: mockHasAccess,
  getAccessFor: vi.fn().mockResolvedValue({
    role: null,
    requestStatus: null,
    requestMessage: null,
  }),
  isOwner: vi.fn().mockResolvedValue(false),
  listMembers: vi.fn(),
  grantAccessByEmail: vi.fn(),
  revokeAccess: vi.fn(),
  createOrRefreshRequest: vi.fn(),
  listRequests: vi.fn(),
  approveRequest: vi.fn(),
  rejectRequest: vi.fn(),
}));

vi.mock("@/modules/journal/entries-repo", () => ({
  listEntries: vi.fn().mockResolvedValue([]),
  getEntryByDate: mockGetByDate,
  createEntry: vi.fn(),
  softDeleteEntry: vi.fn(),
  hashContent: (s: string) => "hash-" + s.length,
}));

vi.mock("@/modules/journal/appends-repo", () => ({
  listAppendsForEntry: vi.fn().mockResolvedValue([]),
  createAppend: vi.fn(),
}));

vi.mock("@/modules/journal/images-repo", () => ({
  insertImage: vi.fn(),
  getImageById: mockGetImageById,
  countUploadsInWindow: vi.fn().mockResolvedValue({ count: 0, oldestCreatedAt: null }),
}));

vi.mock("@/modules/auth/user-prefs", () => ({
  getUserTimezone: vi.fn().mockResolvedValue("America/Chicago"),
  DEFAULT_TIMEZONE: "America/Chicago",
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
  requireScope: () => async (_c: any, next: any) => {
    await next();
  },
}));

import { journalRoutes } from "@/modules/journal/routes";

const app = new Hono().route("/api/journal", journalRoutes);

beforeEach(() => {
  vi.clearAllMocks();
  mockGetByDate.mockResolvedValue({
    entry: { id: "e1", date: "2026-09-10", authorId: "u1" },
    author: null,
    currentVersion: { content: "secret", versionNum: 1 },
  });
});

describe("journal reads are members-only", () => {
  const readPaths = [
    "/api/journal/entries",
    "/api/journal/entries/2026-09-10",
    "/api/journal/entries/2026-09-10/appends",
    "/api/journal/entries/2026-09-10/versions",
    "/api/journal/entries/2026-09-10/neighbors",
    "/api/journal/entries/2026-09-10/suggestions",
    "/api/journal/entries/2026-09-10/comments",
    "/api/journal/entries/2026-09-10/reactions",
  ];

  it.each(readPaths)("403s %s for a signed-out caller", async (path) => {
    mockHasAccess.mockResolvedValue(false);
    const res = await app.request(path);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("journal_access_required");
    // The handler must never have run — no entry body leaks into the response.
    expect(JSON.stringify(body)).not.toContain("secret");
  });

  it.each(readPaths)("403s %s for a signed-in non-member", async (path) => {
    mockHasAccess.mockResolvedValue(false);
    const res = await app.request(path, { headers: { "X-Test-User": "outsider" } });
    expect(res.status).toBe(403);
  });

  it("lets a member through", async () => {
    mockHasAccess.mockResolvedValue(true);
    const res = await app.request("/api/journal/entries/2026-09-10", {
      headers: { "X-Test-User": "u1" },
    });
    expect(res.status).toBe(200);
    expect((await res.json()).content).toBe("secret");
  });

  it("checks membership against the resolved userId, PAT or JWT alike", async () => {
    mockHasAccess.mockResolvedValue(true);
    await app.request("/api/journal/entries", { headers: { "X-Test-User": "u7" } });
    expect(mockHasAccess).toHaveBeenCalledWith("u7");
  });
});

describe("journal writes are members-only", () => {
  it("403s entry creation for a signed-in non-member", async () => {
    mockHasAccess.mockResolvedValue(false);
    const res = await app.request("/api/journal/entries", {
      method: "POST",
      headers: { "X-Test-User": "outsider", "Content-Type": "application/json" },
      body: JSON.stringify({ date: "2026-09-10", content: "hello" }),
    });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("journal_access_required");
  });

  it("403s the inbox for a signed-in non-member", async () => {
    mockHasAccess.mockResolvedValue(false);
    const res = await app.request("/api/journal/inbox", {
      headers: { "X-Test-User": "outsider" },
    });
    expect(res.status).toBe(403);
  });

  it("still 401s an unauthenticated write before reaching the gate", async () => {
    mockHasAccess.mockResolvedValue(false);
    const res = await app.request("/api/journal/entries", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ date: "2026-09-10", content: "hello" }),
    });
    expect(res.status).toBe(401);
    expect(mockHasAccess).not.toHaveBeenCalled();
  });
});

describe("routes deliberately outside the gate", () => {
  it("serves GET /images/:id without membership (an <img> sends no auth header)", async () => {
    mockHasAccess.mockResolvedValue(false);
    mockGetImageById.mockResolvedValue({
      data: Buffer.from([0x89, 0x50]),
      mimeType: "image/png",
      byteSize: 2,
    });
    const res = await app.request(
      "/api/journal/images/11111111-1111-1111-1111-111111111111",
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
    expect(mockHasAccess).not.toHaveBeenCalled();
  });

  it("answers GET /access/me for a non-member — the gate cannot cover the door", async () => {
    mockHasAccess.mockResolvedValue(false);
    const res = await app.request("/api/journal/access/me");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      role: null,
      requestStatus: null,
      requestMessage: null,
    });
  });

  it("keeps PATCH /entries/:date a plain 405 for everyone", async () => {
    mockHasAccess.mockResolvedValue(false);
    const res = await app.request("/api/journal/entries/2026-09-10", { method: "PATCH" });
    expect(res.status).toBe(405);
  });
});
