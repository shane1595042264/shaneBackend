import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { __resetRateLimitBuckets } from "@/modules/shared/rate-limit";

const { mockSelect, mockInsert, mockDelete, mockUpdate, mockSql } = vi.hoisted(() => ({
  mockSelect: vi.fn(),
  mockInsert: vi.fn(),
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
    insert: mockInsert,
    select: mockSelect,
    delete: mockDelete,
    update: mockUpdate,
  },
}));

vi.mock("@/db/schema", () => ({
  vocabWords: {
    id: "vocabWords.id",
    createdBy: "vocabWords.createdBy",
    memorizationLocations: "vocabWords.memorizationLocations",
    longTermMemorized: "vocabWords.longTermMemorized",
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

// X-Test-Token (or legacy X-Test-Token-Id) presence flips JWT -> PAT (sets
// tokenId). X-Test-Scopes is a CSV mapped to tokenScopes; requireScope reads
// it. JWT requests (no token header) keep tokenScopes null and bypass scope
// checks, matching the production middleware contract.
vi.mock("@/modules/auth/middleware", () => ({
  optionalAuth: async (c: any, next: any) => {
    c.set("userId", c.req.header("X-Test-User") ?? null);
    const token = c.req.header("X-Test-Token") ?? c.req.header("X-Test-Token-Id");
    const scopes = c.req.header("X-Test-Scopes");
    c.set("tokenScopes", token ? (scopes ? scopes.split(",") : []) : (scopes ? scopes.split(",") : null));
    c.set("tokenId", token ?? null);
    await next();
  },
  requireAuth: async (c: any, next: any) => {
    const u = c.req.header("X-Test-User");
    if (!u) return c.json({ error: "auth" }, 401);
    c.set("userId", u);
    const token = c.req.header("X-Test-Token") ?? c.req.header("X-Test-Token-Id");
    const scopes = c.req.header("X-Test-Scopes");
    c.set("tokenScopes", token ? (scopes ? scopes.split(",") : []) : (scopes ? scopes.split(",") : null));
    c.set("tokenId", token ?? null);
    await next();
  },
  requireScope: (scope: string) => async (c: any, next: any) => {
    const scopes = c.get("tokenScopes") as string[] | null;
    if (scopes !== null && !scopes.includes(scope)) {
      return c.json({ error: `Token missing required scope: ${scope}` }, 403);
    }
    await next();
  },
}));

vi.mock("@/modules/vocabulary/ai-enricher", () => ({
  enrichWord: vi.fn(),
}));

import { knowledgeRoutes } from "@/modules/knowledge/routes";

beforeEach(() => {
  vi.clearAllMocks();
  __resetRateLimitBuckets();
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

function insertReturning(row: unknown) {
  const valuesFn = vi.fn(() => ({ returning: () => Promise.resolve([row]) }));
  mockInsert.mockImplementation(() => ({ values: valuesFn }));
  return valuesFn;
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

  // SHAN-339: long_term_memorized is derived server-side from the normalized
  // location set, never trusted from the client.
  function captureUpdate() {
    const setFn = vi.fn(() => ({
      where: () => ({ returning: () => Promise.resolve([{ id: validId }]) }),
    }));
    mockUpdate.mockImplementation(() => ({ set: setFn }));
    return setFn;
  }

  it("derives long_term_memorized=false below 7 distinct locations and normalizes them", async () => {
    selectReturning([{ createdBy: "user-1" }]);
    const setFn = captureUpdate();
    const res = await app.request(`/api/knowledge/entries/${validId}`, {
      method: "PUT",
      headers: { ...jsonHeaders, "X-Test-User": "user-1" },
      body: JSON.stringify({ memorizationLocations: ["Cafe", "cafe", " Library "] }),
    });
    expect(res.status).toBe(200);
    const patch = setFn.mock.calls[0][0];
    expect(patch.memorizationLocations).toEqual(["Cafe", "Library"]);
    expect(patch.longTermMemorized).toBe(false);
  });

  it("derives long_term_memorized=true at 7 distinct locations", async () => {
    selectReturning([{ createdBy: "user-1" }]);
    const setFn = captureUpdate();
    const res = await app.request(`/api/knowledge/entries/${validId}`, {
      method: "PUT",
      headers: { ...jsonHeaders, "X-Test-User": "user-1" },
      body: JSON.stringify({
        memorizationLocations: ["a", "b", "c", "d", "e", "f", "g"],
      }),
    });
    expect(res.status).toBe(200);
    const patch = setFn.mock.calls[0][0];
    expect(patch.longTermMemorized).toBe(true);
  });

  it("does not touch memorization columns when the field is absent", async () => {
    selectReturning([{ createdBy: "user-1" }]);
    const setFn = captureUpdate();
    const res = await app.request(`/api/knowledge/entries/${validId}`, {
      method: "PUT",
      headers: { ...jsonHeaders, "X-Test-User": "user-1" },
      body: JSON.stringify({ definition: "edited" }),
    });
    expect(res.status).toBe(200);
    const patch = setFn.mock.calls[0][0];
    expect(patch).not.toHaveProperty("memorizationLocations");
    expect(patch).not.toHaveProperty("longTermMemorized");
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

// The module's CLAUDE.md states the auth contract is "Requires either a JWT
// or a PAT with the knowledge:write scope. Anonymous -> 401." POST /entries
// drifted from that until SHAN-312 — verified live against prod that an
// anonymous POST returned 201. These specs pin the gate down.
describe("POST /api/knowledge/entries — auth gate (SHAN-312)", () => {
  const validId = "11111111-1111-1111-1111-111111111111";
  const body = JSON.stringify({
    word: "hello",
    language: "en",
    category: "vocabulary",
    definition: "a greeting",
    autoEnrich: false,
  });
  const jsonHeaders = { "Content-Type": "application/json" };

  it("returns 401 when unauthenticated", async () => {
    const res = await app.request("/api/knowledge/entries", {
      method: "POST",
      headers: jsonHeaders,
      body,
    });
    expect(res.status).toBe(401);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("returns 403 when PAT lacks knowledge:write scope", async () => {
    const res = await app.request("/api/knowledge/entries", {
      method: "POST",
      headers: {
        ...jsonHeaders,
        "X-Test-User": "user-1",
        "X-Test-Token": "pat-test",
        "X-Test-Scopes": "entries:write",
      },
      body,
    });
    expect(res.status).toBe(403);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("creates the entry and stamps createdBy with the JWT user", async () => {
    selectReturning([]); // duplicate check finds nothing
    const valuesFn = insertReturning({
      id: validId,
      word: "hello",
      language: "en",
      category: "vocabulary",
      createdBy: "user-1",
    });

    const res = await app.request("/api/knowledge/entries", {
      method: "POST",
      headers: { ...jsonHeaders, "X-Test-User": "user-1" },
      body,
    });
    expect(res.status).toBe(201);
    const valuesArg = valuesFn.mock.calls[0]![0] as Record<string, unknown>;
    expect(valuesArg.createdBy).toBe("user-1");
  });

  it("creates the entry with a PAT carrying knowledge:write scope", async () => {
    selectReturning([]);
    insertReturning({
      id: validId,
      word: "ciao",
      language: "it",
      category: "vocabulary",
      createdBy: "user-1",
    });

    const res = await app.request("/api/knowledge/entries", {
      method: "POST",
      headers: {
        ...jsonHeaders,
        "X-Test-User": "user-1",
        "X-Test-Token": "pat-test",
        "X-Test-Scopes": "knowledge:write",
      },
      body: JSON.stringify({ word: "ciao", language: "it", autoEnrich: false }),
    });
    expect(res.status).toBe(201);
  });

  it("still returns 409 on duplicate (auth + scope satisfied)", async () => {
    selectReturning([{ id: validId, word: "hello", language: "en", category: "vocabulary" }]);

    const res = await app.request("/api/knowledge/entries", {
      method: "POST",
      headers: { ...jsonHeaders, "X-Test-User": "user-1" },
      body,
    });
    expect(res.status).toBe(409);
    expect(mockInsert).not.toHaveBeenCalled();
  });
});
