import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

const { mockClassify, mockInsert, mockPostBilibili } = vi.hoisted(() => ({
  mockClassify: vi.fn(),
  mockInsert: vi.fn(),
  mockPostBilibili: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/modules/knowledge/classifier", () => ({
  classifyNote: mockClassify,
}));

vi.mock("@/modules/knowledge/bilibili", () => ({
  postToBilibili: mockPostBilibili,
}));

vi.mock("@/db/client", () => ({
  db: {
    insert: mockInsert,
    select: vi.fn(),
  },
}));

vi.mock("@/db/schema", () => ({
  vocabWords: {},
  vocabConnections: {},
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((c: unknown, v: unknown) => ({ c, v })),
  and: vi.fn((...args: unknown[]) => ({ and: args })),
  or: vi.fn((...args: unknown[]) => ({ or: args })),
  desc: vi.fn((c: unknown) => ({ c, dir: "desc" })),
  ilike: vi.fn(),
  sql: vi.fn(),
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
    const scopesHeader = c.req.header("X-Test-Scopes");
    c.set("tokenScopes", scopesHeader === undefined ? null : scopesHeader.split(","));
    c.set("tokenId", c.req.header("X-Test-Token-Id") ?? null);
    await next();
  },
  requireScope: (scope: string) => async (c: any, next: any) => {
    const scopes = c.get("tokenScopes");
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
import { __resetRateLimitBuckets } from "@/modules/shared/rate-limit";

beforeEach(() => {
  vi.clearAllMocks();
  __resetRateLimitBuckets();
});

const app = new Hono().route("/api/knowledge", knowledgeRoutes);

const baseClassified = {
  category: "vocabulary" as const,
  word: "hello",
  language: "english",
  definition: "greeting",
  pronunciation: "",
  partOfSpeech: "interjection",
  exampleSentence: "",
  labels: [] as string[],
  source: null as null | Record<string, string | null>,
};

function jwtHeaders() {
  return {
    "Content-Type": "application/json",
    "X-Test-User": "user-1",
  };
}

function patHeaders(scopes = "knowledge:write", tokenId = "tok-1") {
  return {
    "Content-Type": "application/json",
    "X-Test-User": "user-1",
    "X-Test-Scopes": scopes,
    "X-Test-Token-Id": tokenId,
  };
}

function insertReturning(rows: unknown[]) {
  const captured: any = {};
  mockInsert.mockImplementation(() => ({
    values: (v: any) => {
      captured.values = v;
      return { returning: () => Promise.resolve(rows) };
    },
  }));
  return captured;
}

describe("POST /api/knowledge/notes — auth", () => {
  it("returns 401 when no auth is provided", async () => {
    mockClassify.mockResolvedValue(baseClassified);
    insertReturning([{ id: "u1", word: "hello" }]);
    const res = await app.request("/api/knowledge/notes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "hello" }),
    });
    expect(res.status).toBe(401);
  });

  it("returns 403 when PAT lacks knowledge:write scope", async () => {
    mockClassify.mockResolvedValue(baseClassified);
    insertReturning([{ id: "u1", word: "hello" }]);
    const res = await app.request("/api/knowledge/notes", {
      method: "POST",
      headers: patHeaders("entries:write"),
      body: JSON.stringify({ text: "hello" }),
    });
    expect(res.status).toBe(403);
  });

  it("allows a JWT-authed request even with no scopes", async () => {
    mockClassify.mockResolvedValue(baseClassified);
    insertReturning([{ id: "u1", word: "hello" }]);
    const res = await app.request("/api/knowledge/notes", {
      method: "POST",
      headers: jwtHeaders(),
      body: JSON.stringify({ text: "hello" }),
    });
    expect(res.status).toBe(201);
  });
});

describe("POST /api/knowledge/notes — single", () => {
  it("legacy single-string request returns { entries: [single entry] }", async () => {
    mockClassify.mockResolvedValue(baseClassified);
    const rowFromDb = { id: "u1", word: "hello", source: null };
    insertReturning([rowFromDb]);
    const res = await app.request("/api/knowledge/notes", {
      method: "POST",
      headers: patHeaders(),
      body: JSON.stringify({ text: "hello = greeting" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0]).toEqual(rowFromDb);
  });

  it("string source hint sets source.app on the saved entry", async () => {
    mockClassify.mockResolvedValue(baseClassified);
    const captured = insertReturning([{ id: "u2" }]);
    const res = await app.request("/api/knowledge/notes", {
      method: "POST",
      headers: patHeaders(),
      body: JSON.stringify({ text: "hello", source: "nibbler" }),
    });
    expect(res.status).toBe(201);
    expect(captured.values.source).toMatchObject({ app: "nibbler" });
  });

  it("object source: caller fields beat classifier fields", async () => {
    mockClassify.mockResolvedValue({
      ...baseClassified,
      source: {
        app: "classifier-app",
        book: "ClassifierBook",
        author: null,
        location: null,
        rawContext: "...",
      },
    });
    const captured = insertReturning([{ id: "u3" }]);
    const res = await app.request("/api/knowledge/notes", {
      method: "POST",
      headers: patHeaders(),
      body: JSON.stringify({
        text: "hello",
        source: { app: "nibbler", book: "CallerBook" },
      }),
    });
    expect(res.status).toBe(201);
    expect(captured.values.source.app).toBe("nibbler");
    expect(captured.values.source.book).toBe("CallerBook");
  });

  it("rejects when both text and notes are present (zod strict)", async () => {
    const res = await app.request("/api/knowledge/notes", {
      method: "POST",
      headers: patHeaders(),
      body: JSON.stringify({ text: "x", notes: [{ text: "y" }] }),
    });
    expect(res.status).toBe(400);
  });

  it("classifier-extracted source flows through when caller sends none", async () => {
    mockClassify.mockResolvedValue({
      ...baseClassified,
      source: {
        app: null,
        book: "War and Peace",
        author: null,
        location: "ch. 3",
        rawContext: "Read this in War and Peace: …",
      },
    });
    const captured = insertReturning([{ id: "u4" }]);
    const res = await app.request("/api/knowledge/notes", {
      method: "POST",
      headers: patHeaders(),
      body: JSON.stringify({ text: "Read this in War and Peace: дворецкий = butler" }),
    });
    expect(res.status).toBe(201);
    expect(captured.values.source.book).toBe("War and Peace");
    expect(captured.values.source.location).toBe("ch. 3");
  });

  it("null source on entry that has no provenance", async () => {
    mockClassify.mockResolvedValue(baseClassified);
    const captured = insertReturning([{ id: "u5" }]);
    const res = await app.request("/api/knowledge/notes", {
      method: "POST",
      headers: patHeaders(),
      body: JSON.stringify({ text: "hello" }),
    });
    expect(res.status).toBe(201);
    expect(captured.values.source).toBeNull();
  });
});

describe("POST /api/knowledge/notes — batch", () => {
  it("returns parallel entries for a 2-note batch", async () => {
    mockClassify
      .mockResolvedValueOnce({ ...baseClassified, word: "alpha" })
      .mockResolvedValueOnce({ ...baseClassified, word: "beta" });

    const inserts: any[] = [];
    mockInsert.mockImplementation(() => ({
      values: (v: any) => {
        inserts.push(v);
        return {
          returning: () =>
            Promise.resolve([{ id: `id-${v.word}`, word: v.word }]),
        };
      },
    }));

    const res = await app.request("/api/knowledge/notes", {
      method: "POST",
      headers: patHeaders("knowledge:write", "tok-batch-1"),
      body: JSON.stringify({ notes: [{ text: "alpha" }, { text: "beta" }] }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.entries).toHaveLength(2);
    expect(body.entries.map((e: any) => e.word)).toEqual(["alpha", "beta"]);
    expect(body.failures).toEqual([]);
  });

  it("returns 400 when batch length exceeds 50", async () => {
    const notes = Array.from({ length: 51 }, (_, i) => ({ text: `n${i}` }));
    const res = await app.request("/api/knowledge/notes", {
      method: "POST",
      headers: patHeaders("knowledge:write", "tok-batch-overflow"),
      body: JSON.stringify({ notes }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 207 with failures[] when some entries fail to classify", async () => {
    mockClassify
      .mockResolvedValueOnce({ ...baseClassified, word: "good" })
      .mockRejectedValueOnce(new Error("classifier_timeout"))
      .mockResolvedValueOnce({ ...baseClassified, word: "also-good" });
    mockInsert.mockImplementation(() => ({
      values: (v: any) => ({
        returning: () => Promise.resolve([{ id: `id-${v.word}`, word: v.word }]),
      }),
    }));

    const res = await app.request("/api/knowledge/notes", {
      method: "POST",
      headers: patHeaders("knowledge:write", "tok-batch-2"),
      body: JSON.stringify({
        notes: [{ text: "good" }, { text: "bad" }, { text: "also-good" }],
      }),
    });
    expect(res.status).toBe(207);
    const body = await res.json();
    expect(body.entries).toHaveLength(2);
    expect(body.failures).toHaveLength(1);
    expect(body.failures[0]).toMatchObject({ index: 1, text: "bad", error: "classifier_timeout" });
  });

  it("returns 502 when every entry in a batch fails (no successes)", async () => {
    mockClassify.mockRejectedValue(new Error("all-providers-down"));
    const res = await app.request("/api/knowledge/notes", {
      method: "POST",
      headers: patHeaders("knowledge:write", "tok-batch-3"),
      body: JSON.stringify({ notes: [{ text: "x" }, { text: "y" }] }),
    });
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.entries).toEqual([]);
    expect(body.failures).toHaveLength(2);
  });

  it("within-batch dedup: same (word, language) twice → one entry, uses first source", async () => {
    mockClassify.mockResolvedValue({ ...baseClassified, word: "duplicado", language: "spanish" });
    const inserts: any[] = [];
    mockInsert.mockImplementation(() => ({
      values: (v: any) => {
        inserts.push(v);
        return {
          returning: () =>
            Promise.resolve([{ id: `id-${inserts.length}`, word: v.word }]),
        };
      },
    }));

    const res = await app.request("/api/knowledge/notes", {
      method: "POST",
      headers: patHeaders("knowledge:write", "tok-batch-dedup"),
      body: JSON.stringify({
        notes: [
          { text: "first", source: { app: "nibbler", book: "FirstBook" } },
          { text: "second", source: { app: "nibbler", book: "SecondBook" } },
        ],
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.entries).toHaveLength(1);
    expect(inserts).toHaveLength(1);
    expect(inserts[0].source.book).toBe("FirstBook");
  });
});

describe("POST /api/knowledge/notes — rate limiting", () => {
  it("returns 429 after exceeding the single-note PAT limit", async () => {
    mockClassify.mockResolvedValue(baseClassified);
    mockInsert.mockImplementation(() => ({
      values: () => ({ returning: () => Promise.resolve([{ id: "u" }]) }),
    }));

    // 30 successful single requests, then the 31st should 429
    const headers = patHeaders("knowledge:write", "tok-rate-single");
    for (let i = 0; i < 30; i++) {
      const ok = await app.request("/api/knowledge/notes", {
        method: "POST",
        headers,
        body: JSON.stringify({ text: `n${i}` }),
      });
      expect(ok.status).toBe(201);
    }
    const limited = await app.request("/api/knowledge/notes", {
      method: "POST",
      headers,
      body: JSON.stringify({ text: "overflow" }),
    });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBe("60");
  });
});
