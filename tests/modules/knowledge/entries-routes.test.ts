import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

const { mockSelect, mockDelete, mockUpdate, mockSql } = vi.hoisted(() => ({
  mockSelect: vi.fn(),
  mockDelete: vi.fn(),
  mockUpdate: vi.fn(),
  // Records the raw template fragments so tests can assert what SQL the
  // route attempted to emit (e.g. "->>'app'" for the source.app filter).
  mockSql: vi.fn((strings: unknown, ..._values: unknown[]) => {
    const raw = Array.isArray((strings as TemplateStringsArray)?.raw)
      ? (strings as TemplateStringsArray).raw.join("?")
      : String(strings);
    return { __sql: raw };
  }),
}));

vi.mock("@/modules/knowledge/classifier", () => ({
  classifyNote: vi.fn(),
}));

vi.mock("@/modules/knowledge/bilibili", () => ({
  postToBilibili: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/db/client", () => ({
  db: {
    insert: vi.fn(),
    select: mockSelect,
    delete: mockDelete,
    update: mockUpdate,
  },
}));

vi.mock("@/db/schema", () => ({
  vocabWords: {
    id: "vocabWords.id",
    createdBy: "vocabWords.createdBy",
  },
  vocabConnections: {},
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((c: unknown, v: unknown) => ({ eq: { c, v } })),
  and: vi.fn((...args: unknown[]) => ({ and: args })),
  or: vi.fn((...args: unknown[]) => ({ or: args })),
  desc: vi.fn((c: unknown) => ({ c, dir: "desc" })),
  ilike: vi.fn(),
  sql: mockSql,
  inArray: vi.fn((c: unknown, vs: unknown[]) => ({ inArray: { c, vs } })),
}));

vi.mock("@/modules/auth/middleware", () => ({
  optionalAuth: async (c: any, next: any) => {
    c.set("userId", c.req.header("X-Test-User") ?? null);
    c.set("tokenScopes", c.req.header("X-Test-Scopes")?.split(",") ?? null);
    c.set("tokenId", c.req.header("X-Test-Token-Id") ?? null);
    await next();
  },
  requireAuth: async (c: any, next: any) => {
    const u = c.req.header("X-Test-User");
    if (!u) return c.json({ error: "auth" }, 401);
    c.set("userId", u);
    c.set("tokenScopes", c.req.header("X-Test-Scopes")?.split(",") ?? null);
    c.set("tokenId", c.req.header("X-Test-Token-Id") ?? null);
    await next();
  },
  requireScope: (_scope: string) => async (_c: any, next: any) => next(),
}));

vi.mock("@/modules/vocabulary/ai-enricher", () => ({
  enrichWord: vi.fn(),
}));

import { knowledgeRoutes } from "@/modules/knowledge/routes";

beforeEach(() => {
  vi.clearAllMocks();
});

const app = new Hono().route("/api/knowledge", knowledgeRoutes);

function selectReturning(rows: unknown[]) {
  mockSelect.mockImplementation(() => ({
    from: () => ({
      where: () => Promise.resolve(rows),
    }),
  }));
}

function deleteReturning(rows: unknown[]) {
  mockDelete.mockImplementation(() => ({
    where: () => ({
      returning: () => Promise.resolve(rows),
    }),
  }));
}

function updateReturning(rows: unknown[]) {
  mockUpdate.mockImplementation(() => ({
    set: () => ({
      where: () => ({
        returning: () => Promise.resolve(rows),
      }),
    }),
  }));
}

describe("DELETE /api/knowledge/entries/:id — ownership", () => {
  const validId = "11111111-1111-1111-1111-111111111111";

  it("returns 401 when unauthenticated", async () => {
    const res = await app.request(`/api/knowledge/entries/${validId}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(401);
  });

  it("returns 404 when entry does not exist", async () => {
    selectReturning([]);
    const res = await app.request(`/api/knowledge/entries/${validId}`, {
      method: "DELETE",
      headers: { "X-Test-User": "user-1" },
    });
    expect(res.status).toBe(404);
  });

  it("returns 403 when caller is not the creator", async () => {
    selectReturning([{ createdBy: "user-other" }]);
    const res = await app.request(`/api/knowledge/entries/${validId}`, {
      method: "DELETE",
      headers: { "X-Test-User": "user-1" },
    });
    expect(res.status).toBe(403);
  });

  it("allows delete when caller is the creator", async () => {
    selectReturning([{ createdBy: "user-1" }]);
    deleteReturning([{ id: validId }]);
    const res = await app.request(`/api/knowledge/entries/${validId}`, {
      method: "DELETE",
      headers: { "X-Test-User": "user-1" },
    });
    expect(res.status).toBe(200);
  });

  it("allows delete on legacy entries (createdBy IS NULL)", async () => {
    selectReturning([{ createdBy: null }]);
    deleteReturning([{ id: validId }]);
    const res = await app.request(`/api/knowledge/entries/${validId}`, {
      method: "DELETE",
      headers: { "X-Test-User": "user-1" },
    });
    expect(res.status).toBe(200);
  });
});

describe("POST /api/knowledge/entries/bulk-delete", () => {
  const ownedId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  const otherId = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
  const legacyId = "cccccccc-cccc-cccc-cccc-cccccccccccc";
  const missingId = "dddddddd-dddd-dddd-dddd-dddddddddddd";

  it("returns 401 when unauthenticated", async () => {
    const res = await app.request(`/api/knowledge/entries/bulk-delete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: [ownedId] }),
    });
    expect(res.status).toBe(401);
  });

  it("returns 400 on empty ids", async () => {
    const res = await app.request(`/api/knowledge/entries/bulk-delete`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Test-User": "user-1" },
      body: JSON.stringify({ ids: [] }),
    });
    expect(res.status).toBe(400);
  });

  it("partitions ids into deleted / denied / notFound based on ownership", async () => {
    selectReturning([
      { id: ownedId, createdBy: "user-1" },
      { id: otherId, createdBy: "user-other" },
      { id: legacyId, createdBy: null },
    ]);
    deleteReturning([{ id: ownedId }, { id: legacyId }]);

    const res = await app.request(`/api/knowledge/entries/bulk-delete`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Test-User": "user-1" },
      body: JSON.stringify({ ids: [ownedId, otherId, legacyId, missingId] }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.deleted.sort()).toEqual([ownedId, legacyId].sort());
    expect(body.denied).toEqual([otherId]);
    expect(body.notFound).toEqual([missingId]);
  });

  it("returns empty deleted with denied populated when nothing is owned", async () => {
    selectReturning([{ id: otherId, createdBy: "user-other" }]);

    const res = await app.request(`/api/knowledge/entries/bulk-delete`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Test-User": "user-1" },
      body: JSON.stringify({ ids: [otherId] }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.deleted).toEqual([]);
    expect(body.denied).toEqual([otherId]);
    expect(mockDelete).not.toHaveBeenCalled();
  });
});

describe("PUT /api/knowledge/entries/:id — ownership (SHAN-222)", () => {
  const validId = "11111111-1111-1111-1111-111111111111";
  const body = JSON.stringify({ definition: "edited" });
  const jsonHeaders = { "Content-Type": "application/json" };

  it("returns 401 when unauthenticated", async () => {
    const res = await app.request(`/api/knowledge/entries/${validId}`, {
      method: "PUT",
      headers: jsonHeaders,
      body,
    });
    expect(res.status).toBe(401);
  });

  it("returns 404 when entry does not exist", async () => {
    selectReturning([]);
    const res = await app.request(`/api/knowledge/entries/${validId}`, {
      method: "PUT",
      headers: { ...jsonHeaders, "X-Test-User": "user-1" },
      body,
    });
    expect(res.status).toBe(404);
  });

  it("returns 403 when caller is not the creator", async () => {
    selectReturning([{ createdBy: "user-other" }]);
    const res = await app.request(`/api/knowledge/entries/${validId}`, {
      method: "PUT",
      headers: { ...jsonHeaders, "X-Test-User": "user-1" },
      body,
    });
    expect(res.status).toBe(403);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("allows edit when caller is the creator", async () => {
    selectReturning([{ createdBy: "user-1" }]);
    updateReturning([{ id: validId, definition: "edited" }]);
    const res = await app.request(`/api/knowledge/entries/${validId}`, {
      method: "PUT",
      headers: { ...jsonHeaders, "X-Test-User": "user-1" },
      body,
    });
    expect(res.status).toBe(200);
  });

  it("allows edit on legacy entries (createdBy IS NULL)", async () => {
    selectReturning([{ createdBy: null }]);
    updateReturning([{ id: validId, definition: "edited" }]);
    const res = await app.request(`/api/knowledge/entries/${validId}`, {
      method: "PUT",
      headers: { ...jsonHeaders, "X-Test-User": "user-1" },
      body,
    });
    expect(res.status).toBe(200);
  });
});

describe("GET /api/knowledge/entries — source.app filter (SHAN-189)", () => {
  // GET /entries uses a fuller chain (orderBy/limit/offset) plus a parallel
  // count query, so we need a richer mock than selectReturning above.
  function selectChain(rows: unknown[]) {
    const c: Record<string, unknown> = {};
    const t = Promise.resolve(rows);
    for (const m of ["from", "where", "orderBy", "limit", "offset"]) {
      c[m] = vi.fn(() => c);
    }
    Object.assign(c, { then: (r: any, j: any) => t.then(r, j) });
    return c;
  }

  function sqlSawAppFilter(): boolean {
    return mockSql.mock.calls.some(([strings]) => {
      const raw = Array.isArray((strings as TemplateStringsArray)?.raw)
        ? (strings as TemplateStringsArray).raw.join("?")
        : String(strings);
      return /->>'app'/.test(raw);
    });
  }

  it("emits the source.app filter when ?app=<value> is provided", async () => {
    mockSelect
      .mockReturnValueOnce(selectChain([{ id: "u1", word: "build", source: { app: "nibbler" } }]))
      .mockReturnValueOnce(selectChain([{ count: 1 }]));

    const res = await app.request("/api/knowledge/entries?app=nibbler");
    expect(res.status).toBe(200);
    expect(sqlSawAppFilter()).toBe(true);
  });

  it("does NOT emit the source.app filter when ?app is omitted", async () => {
    mockSelect
      .mockReturnValueOnce(selectChain([]))
      .mockReturnValueOnce(selectChain([{ count: 0 }]));

    const res = await app.request("/api/knowledge/entries");
    expect(res.status).toBe(200);
    expect(sqlSawAppFilter()).toBe(false);
  });

  it("rejects empty ?app= via zod min(1)", async () => {
    const res = await app.request("/api/knowledge/entries?app=");
    expect(res.status).toBe(400);
  });
});
