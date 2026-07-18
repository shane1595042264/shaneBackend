// Covers the auth gate, ownership rule, and per-PAT rate limit applied to
// /api/vocabulary write endpoints. Mirrors the structure of
// tests/modules/journal/rate-limit-routes.test.ts and the auth/ownership
// assertions in tests/modules/knowledge/entries-routes.test.ts.
//
// The vocabulary module is the legacy CRUD path on the shared vocabWords
// table (the knowledge module is the canonical replacement). Until this
// ticket (SHAN-310) every write was anonymous and unrate-limited — that's
// what these tests pin down so we don't regress.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { __resetRateLimitBuckets } from "@/modules/shared/rate-limit";

const { mockSelect, mockInsert, mockUpdate, mockDelete } = vi.hoisted(() => ({
  mockSelect: vi.fn(),
  mockInsert: vi.fn(),
  mockUpdate: vi.fn(),
  mockDelete: vi.fn(),
}));

vi.mock("@/db/client", () => ({
  db: {
    select: mockSelect,
    insert: mockInsert,
    update: mockUpdate,
    delete: mockDelete,
  },
}));

vi.mock("@/db/schema", () => ({
  vocabWords: { id: "vocabWords.id", createdBy: "vocabWords.createdBy" },
  vocabConnections: { id: "vocabConnections.id" },
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((c: unknown, v: unknown) => ({ eq: { c, v } })),
  and: vi.fn((...args: unknown[]) => ({ and: args })),
  or: vi.fn((...args: unknown[]) => ({ or: args })),
  desc: vi.fn(),
  ilike: vi.fn(),
  sql: vi.fn(),
  inArray: vi.fn((c: unknown, vs: unknown[]) => ({ inArray: { c, vs } })),
}));

vi.mock("@/modules/vocabulary/ai-enricher", () => ({
  enrichWord: vi.fn().mockResolvedValue({
    definition: "ai-def",
    pronunciation: null,
    partOfSpeech: null,
    exampleSentence: null,
    labels: [],
  }),
}));

// X-Test-Token presence flips JWT → PAT (sets tokenId). X-Test-Scopes is a
// CSV that maps to tokenScopes; the real requireScope reads it. Anonymous
// requests omit X-Test-User and fail requireAuth as in prod.
vi.mock("@/modules/auth/middleware", () => ({
  optionalAuth: async (c: any, next: any) => {
    c.set("userId", c.req.header("X-Test-User") ?? null);
    const token = c.req.header("X-Test-Token");
    const scopes = c.req.header("X-Test-Scopes");
    c.set("tokenScopes", token ? (scopes ? scopes.split(",") : []) : null);
    c.set("tokenId", token ?? null);
    await next();
  },
  requireAuth: async (c: any, next: any) => {
    const u = c.req.header("X-Test-User");
    if (!u) return c.json({ error: "auth" }, 401);
    c.set("userId", u);
    const token = c.req.header("X-Test-Token");
    const scopes = c.req.header("X-Test-Scopes");
    c.set("tokenScopes", token ? (scopes ? scopes.split(",") : []) : null);
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

import { vocabularyRoutes } from "@/modules/vocabulary/routes";
import { enrichWord } from "@/modules/vocabulary/ai-enricher";

beforeEach(() => {
  vi.clearAllMocks();
  __resetRateLimitBuckets();
});

const app = new Hono().route("/api/vocabulary", vocabularyRoutes);

function selectRows(rows: unknown[]) {
  mockSelect.mockImplementation(() => ({
    from: () => ({ where: () => Promise.resolve(rows) }),
  }));
}

function insertReturning(row: unknown) {
  const valuesFn = vi.fn(() => ({ returning: () => Promise.resolve([row]) }));
  mockInsert.mockImplementation(() => ({ values: valuesFn }));
  return valuesFn;
}

function updateReturning(row: unknown) {
  mockUpdate.mockImplementation(() => ({
    set: () => ({ where: () => ({ returning: () => Promise.resolve([row]) }) }),
  }));
}

function deleteReturning(row: unknown) {
  mockDelete.mockImplementation(() => ({
    where: () => ({ returning: () => Promise.resolve([row]) }),
  }));
}

function patHeaders(opts: { token?: string; scopes?: string; user?: string } = {}) {
  return {
    "Content-Type": "application/json",
    "X-Test-User": opts.user ?? "u-shane",
    "X-Test-Token": opts.token ?? "pat-test",
    "X-Test-Scopes": opts.scopes ?? "knowledge:write",
  };
}

function jwtHeaders(user = "u-shane") {
  return {
    "Content-Type": "application/json",
    "X-Test-User": user,
  };
}

const validId = "11111111-1111-1111-1111-111111111111";
const otherWordId = "22222222-2222-2222-2222-222222222222";

describe("POST /api/vocabulary/words — auth gate", () => {
  const body = JSON.stringify({ word: "hello", language: "en", autoEnrich: false });

  it("returns 401 without auth", async () => {
    const res = await app.request("/api/vocabulary/words", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    expect(res.status).toBe(401);
  });

  it("returns 403 when PAT lacks knowledge:write scope", async () => {
    const res = await app.request("/api/vocabulary/words", {
      method: "POST",
      headers: patHeaders({ scopes: "entries:write" }),
      body,
    });
    expect(res.status).toBe(403);
  });

  it("creates the word and stamps createdBy with the JWT user", async () => {
    selectRows([]); // duplicate check finds nothing
    const valuesFn = insertReturning({
      id: validId,
      word: "hello",
      language: "en",
      createdBy: "u-shane",
    });
    const res = await app.request("/api/vocabulary/words", {
      method: "POST",
      headers: jwtHeaders("u-shane"),
      body,
    });
    expect(res.status).toBe(201);
    const valuesArg = valuesFn.mock.calls[0]![0] as Record<string, unknown>;
    expect(valuesArg.createdBy).toBe("u-shane");
  });

  it("creates the word with a PAT carrying the right scope", async () => {
    selectRows([]);
    insertReturning({ id: validId, word: "ciao", language: "it", createdBy: "u-shane" });
    const res = await app.request("/api/vocabulary/words", {
      method: "POST",
      headers: patHeaders(),
      body: JSON.stringify({ word: "ciao", language: "it", autoEnrich: false }),
    });
    expect(res.status).toBe(201);
  });
});

describe("PUT /api/vocabulary/words/:id — auth + ownership", () => {
  const body = JSON.stringify({ definition: "updated" });

  it("returns 401 without auth", async () => {
    const res = await app.request(`/api/vocabulary/words/${validId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body,
    });
    expect(res.status).toBe(401);
  });

  it("returns 404 when the word does not exist", async () => {
    selectRows([]);
    const res = await app.request(`/api/vocabulary/words/${validId}`, {
      method: "PUT",
      headers: jwtHeaders(),
      body,
    });
    expect(res.status).toBe(404);
  });

  it("returns 403 when caller is not the creator (non-null createdBy)", async () => {
    selectRows([{ createdBy: "u-someone-else" }]);
    const res = await app.request(`/api/vocabulary/words/${validId}`, {
      method: "PUT",
      headers: jwtHeaders("u-shane"),
      body,
    });
    expect(res.status).toBe(403);
  });

  it("allows update when createdBy is null (legacy row)", async () => {
    selectRows([{ createdBy: null }]);
    updateReturning({ id: validId, definition: "updated" });
    const res = await app.request(`/api/vocabulary/words/${validId}`, {
      method: "PUT",
      headers: jwtHeaders("u-shane"),
      body,
    });
    expect(res.status).toBe(200);
  });

  it("allows update when caller is the creator", async () => {
    selectRows([{ createdBy: "u-shane" }]);
    updateReturning({ id: validId, definition: "updated" });
    const res = await app.request(`/api/vocabulary/words/${validId}`, {
      method: "PUT",
      headers: jwtHeaders("u-shane"),
      body,
    });
    expect(res.status).toBe(200);
  });
});

describe("DELETE /api/vocabulary/words/:id — auth + ownership", () => {
  it("returns 401 without auth", async () => {
    const res = await app.request(`/api/vocabulary/words/${validId}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(401);
  });

  it("returns 403 when caller is not the creator", async () => {
    selectRows([{ createdBy: "u-someone-else" }]);
    const res = await app.request(`/api/vocabulary/words/${validId}`, {
      method: "DELETE",
      headers: jwtHeaders("u-shane"),
    });
    expect(res.status).toBe(403);
  });

  it("deletes when caller is the creator", async () => {
    selectRows([{ createdBy: "u-shane" }]);
    deleteReturning({ id: validId });
    const res = await app.request(`/api/vocabulary/words/${validId}`, {
      method: "DELETE",
      headers: jwtHeaders("u-shane"),
    });
    expect(res.status).toBe(200);
  });
});

describe("POST /api/vocabulary/words/:id/enrich — auth gate", () => {
  it("returns 401 without auth", async () => {
    const res = await app.request(`/api/vocabulary/words/${validId}/enrich`, {
      method: "POST",
    });
    expect(res.status).toBe(401);
  });

  it("returns 403 when PAT lacks knowledge:write scope", async () => {
    const res = await app.request(`/api/vocabulary/words/${validId}/enrich`, {
      method: "POST",
      headers: patHeaders({ scopes: "reactions:write" }),
    });
    expect(res.status).toBe(403);
  });

  // SHAN-344: never leak raw err.message (Postgres/driver internals or Anthropic
  // API error bodies) to callers — mirrors the SHAN-343 hardening.
  it("returns a generic 500 body (no raw driver text) when enrichment throws", async () => {
    const secret =
      "connection terminated: password authentication failed for user postgres";
    selectRows([{ id: validId, word: "build", language: "en" }]);
    vi.mocked(enrichWord).mockRejectedValueOnce(new Error(secret));

    const res = await app.request(`/api/vocabulary/words/${validId}/enrich`, {
      method: "POST",
      headers: jwtHeaders("u-shane"),
    });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Enrichment failed");
    expect(JSON.stringify(body)).not.toContain("password");
  });

  it("maps LLM-provider exhaustion to a safe 502 without leaking provider internals", async () => {
    selectRows([{ id: validId, word: "build", language: "en" }]);
    vi.mocked(enrichWord).mockRejectedValueOnce(
      new Error("All LLM providers failed. Anthropic: 401 invalid x-api-key; Groq: 429")
    );

    const res = await app.request(`/api/vocabulary/words/${validId}/enrich`, {
      method: "POST",
      headers: jwtHeaders("u-shane"),
    });
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(JSON.stringify(body)).not.toContain("x-api-key");
    expect(JSON.stringify(body)).not.toContain("Anthropic");
  });
});

describe("POST /api/vocabulary/connections — auth gate", () => {
  const body = JSON.stringify({
    fromWordId: validId,
    toWordId: otherWordId,
    connectionType: "synonym",
  });

  it("returns 401 without auth", async () => {
    const res = await app.request("/api/vocabulary/connections", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    expect(res.status).toBe(401);
  });

  it("returns 403 when PAT lacks knowledge:write scope", async () => {
    const res = await app.request("/api/vocabulary/connections", {
      method: "POST",
      headers: patHeaders({ scopes: "comments:write" }),
      body,
    });
    expect(res.status).toBe(403);
  });
});

describe("DELETE /api/vocabulary/connections/:id — auth gate", () => {
  it("returns 401 without auth", async () => {
    const res = await app.request(`/api/vocabulary/connections/${validId}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(401);
  });
});

// SHAN-401: oversized string fields must be rejected with 400 by the zod
// schema BEFORE any DB write, mirroring the knowledge module's bounds on the
// shared vocabWords columns. If validation is skipped the mocked db.insert
// would resolve and return 201 — these tests fail loudly if a bound is dropped.
describe("POST /api/vocabulary/words — payload bounds (SHAN-401)", () => {
  it.each([
    ["word", { word: "a".repeat(256), language: "en" }],
    ["language", { word: "hi", language: "e".repeat(51) }],
    ["definition", { word: "hi", language: "en", definition: "d".repeat(20001) }],
    ["pronunciation", { word: "hi", language: "en", pronunciation: "p".repeat(256) }],
    ["partOfSpeech", { word: "hi", language: "en", partOfSpeech: "x".repeat(51) }],
    ["exampleSentence", { word: "hi", language: "en", exampleSentence: "s".repeat(2001) }],
    ["a label item", { word: "hi", language: "en", labels: ["l".repeat(101)] }],
    ["too many labels", { word: "hi", language: "en", labels: Array(51).fill("l") }],
  ])("rejects oversized %s with 400", async (_field, payload) => {
    // db mocks left unconfigured — a 201 would mean validation was bypassed.
    const res = await app.request("/api/vocabulary/words", {
      method: "POST",
      headers: jwtHeaders("u-shane"),
      body: JSON.stringify({ ...payload, autoEnrich: false }),
    });
    expect(res.status).toBe(400);
  });

  it("accepts a word at the exact field limits (201)", async () => {
    selectRows([]);
    insertReturning({ id: validId, word: "ok", language: "en", createdBy: "u-shane" });
    const res = await app.request("/api/vocabulary/words", {
      method: "POST",
      headers: jwtHeaders("u-shane"),
      body: JSON.stringify({
        word: "a".repeat(255),
        language: "e".repeat(50),
        definition: "d".repeat(20000),
        pronunciation: "p".repeat(255),
        partOfSpeech: "x".repeat(50),
        exampleSentence: "s".repeat(2000),
        labels: Array(50).fill("l".repeat(100)),
        autoEnrich: false,
      }),
    });
    expect(res.status).toBe(201);
  });
});

describe("PUT /api/vocabulary/words/:id — payload bounds (SHAN-401)", () => {
  it("rejects an oversized definition with 400 before touching the DB", async () => {
    const res = await app.request(`/api/vocabulary/words/${validId}`, {
      method: "PUT",
      headers: jwtHeaders("u-shane"),
      body: JSON.stringify({ definition: "d".repeat(20001) }),
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /api/vocabulary/connections — payload bounds (SHAN-401)", () => {
  it("rejects an oversized note with 400", async () => {
    const res = await app.request("/api/vocabulary/connections", {
      method: "POST",
      headers: jwtHeaders("u-shane"),
      body: JSON.stringify({
        fromWordId: validId,
        toWordId: otherWordId,
        connectionType: "synonym",
        note: "n".repeat(1001),
      }),
    });
    expect(res.status).toBe(400);
  });
});

describe("vocabulary write rate limits (per PAT)", () => {
  const body = JSON.stringify({ word: "spam", language: "en", autoEnrich: false });

  it("vocabulary-writes bucket 429s a PAT after 30 POSTs in a minute", async () => {
    selectRows([]); // every dup-check is empty
    insertReturning({ id: validId, word: "spam", language: "en" });
    const headers = patHeaders();
    for (let i = 0; i < 30; i++) {
      const res = await app.request("/api/vocabulary/words", {
        method: "POST",
        headers,
        body,
      });
      expect(res.status).toBe(201);
    }
    const blocked = await app.request("/api/vocabulary/words", {
      method: "POST",
      headers,
      body,
    });
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("Retry-After")).toBe("60");
  });

  it("JWT requests bypass the limiter regardless of count", async () => {
    selectRows([]);
    insertReturning({ id: validId, word: "spam", language: "en" });
    const headers = jwtHeaders();
    for (let i = 0; i < 40; i++) {
      const res = await app.request("/api/vocabulary/words", {
        method: "POST",
        headers,
        body,
      });
      expect(res.status).toBe(201);
    }
  });

  it("isolates the writes bucket per PAT id", async () => {
    selectRows([]);
    insertReturning({ id: validId, word: "spam", language: "en" });
    for (let i = 0; i < 30; i++) {
      const r = await app.request("/api/vocabulary/words", {
        method: "POST",
        headers: patHeaders({ token: "pat-alpha" }),
        body,
      });
      expect(r.status).toBe(201);
    }
    const alphaBlocked = await app.request("/api/vocabulary/words", {
      method: "POST",
      headers: patHeaders({ token: "pat-alpha" }),
      body,
    });
    expect(alphaBlocked.status).toBe(429);

    const beta = await app.request("/api/vocabulary/words", {
      method: "POST",
      headers: patHeaders({ token: "pat-beta" }),
      body,
    });
    expect(beta.status).toBe(201);
  });

  it("enrich bucket (10/min) is independent from the writes bucket", async () => {
    // Burn enrich up to its limit first.
    selectRows([{ id: validId, word: "wow", language: "en", createdBy: "u-shane", definition: "old" }]);
    updateReturning({ id: validId, word: "wow", language: "en", definition: "new" });
    const headers = patHeaders();
    for (let i = 0; i < 10; i++) {
      const r = await app.request(`/api/vocabulary/words/${validId}/enrich`, {
        method: "POST",
        headers,
      });
      expect(r.status).toBe(200);
    }
    const enrichBlocked = await app.request(`/api/vocabulary/words/${validId}/enrich`, {
      method: "POST",
      headers,
    });
    expect(enrichBlocked.status).toBe(429);

    // Writes still go through — different bucket, different counter.
    selectRows([]);
    insertReturning({ id: validId, word: "still-ok", language: "en" });
    const stillOk = await app.request("/api/vocabulary/words", {
      method: "POST",
      headers,
      body: JSON.stringify({ word: "still-ok", language: "en", autoEnrich: false }),
    });
    expect(stillOk.status).toBe(201);
  });
});
