import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

const { mockSelect } = vi.hoisted(() => ({ mockSelect: vi.fn() }));

vi.mock("@/db/client", () => ({
  db: { select: mockSelect },
}));
vi.mock("@/db/schema", () => ({
  journalEntries: { date: "date_col", status: "status_col" },
  journalVersions: {},
  journalSuggestions: {},
}));
vi.mock("@/modules/journal/entries-repo", () => ({
  listEntries: vi.fn(),
  getEntryByDate: vi.fn(),
  createEntry: vi.fn(),
  softDeleteEntry: vi.fn(),
  hashContent: (s: string) => s,
}));
vi.mock("@/modules/journal/versions-repo", () => ({
  appendDirectVersion: vi.fn(),
  listVersions: vi.fn(),
  getVersion: vi.fn(),
  revertToVersion: vi.fn(),
  VersionConflictError: class extends Error {},
}));
vi.mock("@/modules/auth/middleware", () => ({
  optionalAuth: async (_c: any, next: any) => { await next(); },
  requireAuth: async (_c: any, next: any) => { await next(); },
  requireScope: () => async (_c: any, next: any) => { await next(); },
}));
vi.mock("drizzle-orm", () => ({
  eq: vi.fn((c, v) => ({ c, v })),
  and: vi.fn((...a) => ({ and: a })),
  asc: vi.fn(),
  desc: vi.fn(),
  lt: vi.fn(),
  gt: vi.fn(),
  sql: vi.fn(),
}));

function chain(rows: unknown[]) {
  const c: Record<string, unknown> = {};
  const t = Promise.resolve(rows);
  for (const m of ["from", "where", "orderBy", "limit", "leftJoin"]) c[m] = vi.fn(() => c);
  Object.assign(c, { then: (r: any, j: any) => t.then(r, j) });
  return c;
}

import { journalRoutes } from "@/modules/journal/routes";

beforeEach(() => vi.clearAllMocks());

const app = new Hono().route("/api/journal", journalRoutes);

describe("GET /api/journal/entries/:date/neighbors", () => {
  it("returns the prev and next dates when both exist", async () => {
    let call = 0;
    mockSelect.mockImplementation(() => {
      call++;
      return chain([{ date: call === 1 ? "2026-04-28" : "2026-04-30" }]);
    });
    const res = await app.request("/api/journal/entries/2026-04-29/neighbors");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ prev: "2026-04-28", next: "2026-04-30" });
  });

  it("returns null for prev/next when none exist", async () => {
    mockSelect.mockImplementation(() => chain([]));
    const res = await app.request("/api/journal/entries/2026-04-29/neighbors");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ prev: null, next: null });
  });
});
