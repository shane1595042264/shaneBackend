// SHAN-545: the two vocab search endpoints must hand Postgres an escaped
// pattern, not the raw search term wrapped in percent signs.
//
// `%` and `_` are LIKE metacharacters, so `%_%` means "any non-empty string"
// and `%%%` means "anything". Measured on prod before the fix: both
// `/api/vocabulary/words?search=_` and `/api/knowledge/entries?search=_`
// reported `total: 48` out of 48 rows, as did `search=%`, while `search=a`
// correctly reported 47. The endpoints looked fine for every term that
// happened to contain neither character.
//
// blog/posts-repo.ts and journal/entries-repo.ts already escaped; these two
// were written later without it. tests/modules/shared/like.test.ts guards the
// helper and the absence of inline patterns; this file guards the wiring, by
// asserting on the value handed to `ilike` — the only place the guarantee
// lives, since there is no real DB in this suite.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { __resetRateLimitBuckets } from "@/modules/shared/rate-limit";

const { mockSelect, mockInsert, mockUpdate, mockDelete, mockExecute, mockIlike } =
  vi.hoisted(() => ({
    mockSelect: vi.fn(),
    mockInsert: vi.fn(),
    mockUpdate: vi.fn(),
    mockDelete: vi.fn(),
    mockExecute: vi.fn(),
    mockIlike: vi.fn((c: unknown, v: unknown) => ({ ilike: { c, v } })),
  }));

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
    word: "vocabWords.word",
    definition: "vocabWords.definition",
    exampleSentence: "vocabWords.exampleSentence",
    pronunciation: "vocabWords.pronunciation",
    partOfSpeech: "vocabWords.partOfSpeech",
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
  ilike: mockIlike,
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

// Same split as tests/modules/shared/offset-pagination-ordering.test.ts: the
// count query projects a field list, the page query does not.
function stubList() {
  mockSelect.mockImplementation((fields?: unknown) => {
    if (fields !== undefined) {
      return { from: () => ({ where: () => Promise.resolve([{ count: 0 }]) }) };
    }
    return {
      from: () => ({
        where: () => ({
          orderBy: () => ({ limit: () => ({ offset: () => Promise.resolve([]) }) }),
        }),
      }),
    };
  });
}

/** Every pattern string the route passed to `ilike`, deduplicated. */
function patternsPassedToIlike(): string[] {
  return [...new Set(mockIlike.mock.calls.map((call) => call[1] as string))];
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetRateLimitBuckets();
});

const CASES = [
  // [label, search term, the pattern Postgres must receive]
  ["a lone underscore", "_", "%\\_%"],
  ["a lone percent", "%", "%\\%%"],
  ["a snake_case identifier", "snake_case", "%snake\\_case%"],
  ["a dunder name", "__init__", "%\\_\\_init\\_\\_%"],
  ["a backslash", "a\\b", "%a\\\\b%"],
  ["an ordinary term", "mustache", "%mustache%"],
] as const;

describe.each([
  ["knowledge", "/api/knowledge/entries"],
  ["vocabulary", "/api/vocabulary/words"],
])("GET %s — search escapes LIKE metacharacters", (_name, path) => {
  it.each(CASES)("%s", async (_label, term, expected) => {
    stubList();

    const res = await app.request(`${path}?search=${encodeURIComponent(term)}`);

    expect(res.status).toBe(200);
    // `word` is the one column both routes search, so both reach ilike.
    expect(patternsPassedToIlike()).toContain(expected);
  });

  it("never sends a pattern that would match the whole table", async () => {
    stubList();

    await app.request(`${path}?search=${encodeURIComponent("_")}`);
    expect(patternsPassedToIlike()).not.toContain("%_%");

    vi.clearAllMocks();
    stubList();

    await app.request(`${path}?search=${encodeURIComponent("%")}`);
    expect(patternsPassedToIlike()).not.toContain("%%%");
  });
});
