// SHAN-515: the two list endpoints that page with LIMIT/OFFSET instead of a
// keyset cursor must order by (created_at, id), not created_at alone.
//
// `created_at` is not unique, and Postgres guarantees nothing about the
// relative order of rows that tie on the ORDER BY key. Page 1 and page 2 are
// separate queries, so a tied row can land in both or in neither — one entry
// shows twice and another disappears, with no error anywhere. SHAN-513 closed
// this for every `nextCursor` endpoint via modules/shared/keyset.ts; these two
// emit `total`/`limit`/`offset` instead and were missed.
//
// They page for real: apps/shell/app/knowledge/page.tsx (the SHAN-509 server
// shell) and apps/shell/lib/knowledge-api.ts `fetchAllEntries` both walk
// offset 0, 100, 200 … over these routes.
//
// The assertion is on the arguments handed to `orderBy`, which is the only
// place the guarantee lives — there is no real DB in this suite (see
// tests/modules/journal/entries-repo.test.ts for the house pattern).
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { __resetRateLimitBuckets } from "@/modules/shared/rate-limit";

const { mockSelect, mockInsert, mockUpdate, mockDelete, mockExecute } = vi.hoisted(
  () => ({
    mockSelect: vi.fn(),
    mockInsert: vi.fn(),
    mockUpdate: vi.fn(),
    mockDelete: vi.fn(),
    mockExecute: vi.fn(),
  })
);

vi.mock("@/db/client", () => ({
  db: {
    select: mockSelect,
    insert: mockInsert,
    update: mockUpdate,
    delete: mockDelete,
    execute: mockExecute,
  },
}));

vi.mock("@/db/schema", () => ({
  vocabWords: {
    id: "vocabWords.id",
    createdAt: "vocabWords.createdAt",
    createdBy: "vocabWords.createdBy",
    language: "vocabWords.language",
    labels: "vocabWords.labels",
    memorizationLocations: "vocabWords.memorizationLocations",
    longTermMemorized: "vocabWords.longTermMemorized",
  },
  vocabConnections: {},
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((c: unknown, v: unknown) => ({ eq: { c, v } })),
  and: vi.fn((...args: unknown[]) => ({ and: args })),
  or: vi.fn((...args: unknown[]) => ({ or: args })),
  desc: vi.fn((c: unknown) => ({ desc: c })),
  ilike: vi.fn((c: unknown, v: unknown) => ({ ilike: { c, v } })),
  sql: vi.fn(() => ({ __sql: true })),
  inArray: vi.fn((c: unknown, vs: unknown[]) => ({ inArray: { c, vs } })),
}));

vi.mock("@/modules/knowledge/classifier", () => ({ classifyNote: vi.fn() }));
vi.mock("@/modules/knowledge/bilibili", () => ({
  postToBilibili: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/modules/vocabulary/ai-enricher", () => ({ enrichWord: vi.fn() }));

vi.mock("@/modules/auth/middleware", () => ({
  optionalAuth: async (c: any, next: any) => {
    c.set("userId", null);
    c.set("tokenScopes", null);
    c.set("tokenId", null);
    await next();
  },
  requireAuth: async (c: any, next: any) => {
    c.set("userId", "user-1");
    await next();
  },
  requireScope: () => async (_c: any, next: any) => {
    await next();
  },
}));

import { knowledgeRoutes } from "@/modules/knowledge/routes";
import { vocabularyRoutes } from "@/modules/vocabulary/routes";

const app = new Hono()
  .route("/api/knowledge", knowledgeRoutes)
  .route("/api/vocabulary", vocabularyRoutes);

// The list route fires the page query and the count query in one Promise.all.
// They differ by the argument to `select`: the count query projects
// `{ count: sql\`...\` }`, the page query projects the whole row. Splitting on
// that keeps one mock able to serve both shapes.
function stubList(rows: unknown[]) {
  const orderByCalls: unknown[][] = [];

  mockSelect.mockImplementation((fields?: unknown) => {
    if (fields !== undefined) {
      return {
        from: () => ({ where: () => Promise.resolve([{ count: rows.length }]) }),
      };
    }
    return {
      from: () => ({
        where: () => ({
          orderBy: (...args: unknown[]) => {
            orderByCalls.push(args);
            return { limit: () => ({ offset: () => Promise.resolve(rows) }) };
          },
        }),
      }),
    };
  });

  return orderByCalls;
}

const ROWS = [
  { id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", word: "beta" },
  { id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", word: "alpha" },
];

// Both halves of the compound key, in order. `desc` is mocked to tag its
// column, so this is exactly what Postgres would receive.
const EXPECTED_ORDER = [
  { desc: "vocabWords.createdAt" },
  { desc: "vocabWords.id" },
];

beforeEach(() => {
  vi.clearAllMocks();
  __resetRateLimitBuckets();
});

describe("GET /api/knowledge/entries — deterministic page order", () => {
  it("orders by createdAt then id so tied rows cannot shift between pages", async () => {
    const orderByCalls = stubList(ROWS);

    const res = await app.request("/api/knowledge/entries?limit=1&offset=0");

    expect(res.status).toBe(200);
    expect(orderByCalls).toHaveLength(1);
    expect(orderByCalls[0]).toEqual(EXPECTED_ORDER);
  });

  it("keeps the tiebreaker when filters narrow the query", async () => {
    const orderByCalls = stubList(ROWS);

    const res = await app.request(
      "/api/knowledge/entries?search=alpha&language=english&limit=50&offset=50"
    );

    expect(res.status).toBe(200);
    expect(orderByCalls[0]).toEqual(EXPECTED_ORDER);
  });
});

describe("GET /api/vocabulary/words — deterministic page order", () => {
  it("orders by createdAt then id, matching the knowledge route", async () => {
    const orderByCalls = stubList(ROWS);

    const res = await app.request("/api/vocabulary/words?limit=1&offset=0");

    expect(res.status).toBe(200);
    expect(orderByCalls).toHaveLength(1);
    expect(orderByCalls[0]).toEqual(EXPECTED_ORDER);
  });

  it("keeps the tiebreaker when filters narrow the query", async () => {
    const orderByCalls = stubList(ROWS);

    const res = await app.request(
      "/api/vocabulary/words?search=alpha&label=coding&limit=50&offset=50"
    );

    expect(res.status).toBe(200);
    expect(orderByCalls[0]).toEqual(EXPECTED_ORDER);
  });
});

// SHAN-529: the same two routes, same query param, different failure. `offset`
// was `z.coerce.number().int().min(0)` with no ceiling, so Zod waved through
// anything JS calls an integer — 1e30, 2^63 — and drizzle handed it to Postgres
// as the OFFSET parameter, which threw (`invalid input syntax for type bigint:
// "1e+30"`). The global handler turned that into `500 Internal Server Error`
// for what is plainly a client mistake. Both URLs below returned 500 on prod
// before the bound; they must now 400 without the query ever running.
const OVERFLOW_OFFSETS = [
  ["exponent notation", "1e30"],
  ["bigint max", "9223372036854775807"],
  ["past bigint", "99999999999999999999"],
  ["past the page bound", "1000001"],
] as const;

describe.each([
  ["knowledge", "/api/knowledge/entries"],
  ["vocabulary", "/api/vocabulary/words"],
])("GET %s — offset bounds", (_name, path) => {
  it.each(OVERFLOW_OFFSETS)("400s on an offset with %s", async (_label, offset) => {
    stubList(ROWS);

    const res = await app.request(`${path}?offset=${offset}`);

    expect(res.status).toBe(400);
    expect(mockSelect).not.toHaveBeenCalled();
  });

  it("still serves an offset at the bound", async () => {
    stubList(ROWS);

    const res = await app.request(`${path}?offset=1000000`);

    expect(res.status).toBe(200);
  });

  it("still serves a realistic page offset", async () => {
    stubList(ROWS);

    const res = await app.request(`${path}?limit=100&offset=200`);

    expect(res.status).toBe(200);
  });
});
