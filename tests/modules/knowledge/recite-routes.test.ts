import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { __resetRateLimitBuckets } from "@/modules/shared/rate-limit";

const { mockSelect, mockTransaction, mockUpsertLocation, mockJudge } = vi.hoisted(() => ({
  mockSelect: vi.fn(),
  mockTransaction: vi.fn(),
  mockUpsertLocation: vi.fn(),
  mockJudge: vi.fn(),
}));

vi.mock("@/modules/knowledge/classifier", () => ({ classifyNote: vi.fn() }));
vi.mock("@/modules/knowledge/bilibili", () => ({ postToBilibili: vi.fn() }));
vi.mock("@/modules/vocabulary/ai-enricher", () => ({ enrichWord: vi.fn() }));
vi.mock("@/modules/practice/locations-repo", () => ({ upsertLocation: mockUpsertLocation }));

// Only the judge is mocked; buildHints is the real one, so the hint a miss
// returns is the hint a learner would actually see.
vi.mock("@/modules/knowledge/recite", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/modules/knowledge/recite")>();
  return { ...real, judgeRecital: mockJudge };
});

vi.mock("@/db/client", () => ({
  db: { select: mockSelect, transaction: mockTransaction },
}));

vi.mock("@/db/schema", () => ({
  vocabWords: {
    id: "vocabWords.id",
    category: "vocabWords.category",
    createdBy: "vocabWords.createdBy",
    definition: "vocabWords.definition",
    memorizationLocations: "vocabWords.memorizationLocations",
  },
  vocabConnections: {},
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((c: unknown, v: unknown) => ({ eq: { c, v } })),
  and: vi.fn((...args: unknown[]) => ({ and: args })),
  or: vi.fn((...args: unknown[]) => ({ or: args })),
  isNull: vi.fn((c: unknown) => ({ isNull: c })),
  desc: vi.fn(),
  ilike: vi.fn(),
  inArray: vi.fn((c: unknown, vs: unknown[]) => ({ inArray: { c, vs } })),
  sql: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({ sql: strings.raw.join("?"), values })),
}));

vi.mock("@/modules/auth/middleware", () => ({
  optionalAuth: async (_c: any, next: any) => next(),
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
    if (scopes !== null && !scopes.includes(scope)) return c.json({ error: `missing ${scope}` }, 403);
    await next();
  },
}));

import { knowledgeRoutes } from "@/modules/knowledge/routes";

const app = new Hono().route("/api/knowledge", knowledgeRoutes);
const ME = "11111111-1111-1111-1111-111111111111";
const CARD_ID = "22222222-2222-2222-2222-222222222222";
const DMESG =
  "A command on Unix-like operating systems that prints or controls the kernel ring buffer, standing for 'display message' or 'driver message'.";

const card = (over: Record<string, unknown> = {}) => ({
  id: CARD_ID,
  word: "dmesg",
  category: "coding",
  definition: DMESG,
  exampleSentence: "dmesg | grep -i error",
  labels: ["linux"],
  memorizationLocations: ["pmg"],
  createdBy: ME,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  __resetRateLimitBuckets();
  mockUpsertLocation.mockImplementation(async (_u: string, name: string) => ({
    id: "loc-1",
    name: name.trim().toLowerCase() === "mirra" ? "Mirra" : name.trim(),
  }));
});

function post(path: string, body: unknown, headers: Record<string, string> = { "X-Test-User": ME }) {
  return app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("POST /api/knowledge/recite/deck", () => {
  function deckReturns(cards: unknown[], categories: unknown[]) {
    // First select() is the deck, second the per-category counts.
    mockSelect
      .mockImplementationOnce(() => ({
        from: () => ({ where: () => ({ orderBy: () => ({ limit: () => Promise.resolve(cards) }) }) }),
      }))
      .mockImplementationOnce(() => ({
        from: () => ({ where: () => ({ groupBy: () => ({ orderBy: () => Promise.resolve(categories) }) }) }),
      }));
  }

  it("401s anonymous callers", async () => {
    const res = await post("/api/knowledge/recite/deck", { location: "Mirra" }, {});
    expect(res.status).toBe(401);
  });

  it("403s a PAT without knowledge:write", async () => {
    const res = await post(
      "/api/knowledge/recite/deck",
      { location: "Mirra" },
      { "X-Test-User": ME, "X-Test-Token": "t", "X-Test-Scopes": "comments:write" }
    );
    expect(res.status).toBe(403);
  });

  it("400s a blank location and unknown keys", async () => {
    expect((await post("/api/knowledge/recite/deck", { location: "   " })).status).toBe(400);
    expect((await post("/api/knowledge/recite/deck", { location: "x", shuffle: true })).status).toBe(400);
  });

  it("saves the location and returns the deck under its canonical name", async () => {
    deckReturns([card()], [{ category: "coding", total: 27, remaining: 12 }]);
    const res = await post("/api/knowledge/recite/deck", { location: "  MIRRA " });
    expect(res.status).toBe(200);
    expect(mockUpsertLocation).toHaveBeenCalledWith(ME, "MIRRA");
    const body = await res.json();
    expect(body.location).toEqual({ id: "loc-1", name: "Mirra" });
    expect(body.total).toBe(1);
    expect(body.cards[0].id).toBe(CARD_ID);
    expect(body.categories).toEqual([{ category: "coding", total: 27, remaining: 12 }]);
  });

  it("filters by category and excludes cards memorized at the place, case-insensitively", async () => {
    deckReturns([], []);
    const { inArray, sql } = await import("drizzle-orm");
    await post("/api/knowledge/recite/deck", { location: "Mirra", categories: ["coding"] });
    expect(inArray).toHaveBeenCalledWith("vocabWords.category", ["coding"]);
    const notExists = vi.mocked(sql).mock.results.find((r) => String((r.value as { sql: string }).sql).includes("NOT EXISTS"));
    expect(notExists).toBeDefined();
    expect((notExists!.value as { sql: string }).sql).toContain("lower(loc) = lower(");
    expect((notExists!.value as { values: unknown[] }).values).toContain("Mirra");
  });
});

describe("POST /api/knowledge/entries/:id/recite", () => {
  function cardIs(row: unknown) {
    mockSelect.mockImplementationOnce(() => ({ from: () => ({ where: () => Promise.resolve(row ? [row] : []) }) }));
  }

  const attempt = (body: Record<string, unknown>) =>
    post(`/api/knowledge/entries/${CARD_ID}/recite`, { location: "Mirra", answer: "kernel log", ...body });

  it("404s an unknown card", async () => {
    cardIs(null);
    expect((await attempt({})).status).toBe(404);
  });

  it("403s someone else's card and 422s a card with nothing to recite", async () => {
    cardIs(card({ createdBy: "someone-else" }));
    expect((await attempt({})).status).toBe(403);
    cardIs(card({ definition: "  " }));
    expect((await attempt({})).status).toBe(422);
    expect(mockJudge).not.toHaveBeenCalled();
  });

  it("lets anyone signed in recite a legacy ownerless card", async () => {
    cardIs(card({ createdBy: null }));
    mockJudge.mockResolvedValue({ correct: false, score: 10, feedback: "Not quite.", judge: "ai" });
    expect((await attempt({})).status).toBe(200);
  });

  it("returns one more hint per missed attempt and writes nothing", async () => {
    mockJudge.mockResolvedValue({ correct: false, score: 30, feedback: "Part of it.", judge: "ai" });
    cardIs(card());
    const first = await (await attempt({ attempt: 1 })).json();
    expect(first).toMatchObject({ correct: false, hintNumber: 1, hintsTotal: 3, hint: { kind: "example" } });
    cardIs(card());
    const second = await (await attempt({ attempt: 2 })).json();
    expect(second.hint.kind).toBe("opening");
    cardIs(card());
    const tenth = await (await attempt({ attempt: 10 })).json();
    expect(tenth).toMatchObject({ hintNumber: 3, hint: { kind: "shape" } });
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(mockUpsertLocation).not.toHaveBeenCalled();
  });

  it("records the place on a pass, keeping what the card already held", async () => {
    cardIs(card());
    mockJudge.mockResolvedValue({ correct: true, score: 95, feedback: "Got it.", judge: "ai" });
    const set = vi.fn(() => ({ where: () => ({ returning: () => Promise.resolve([card({ memorizationLocations: ["pmg", "Mirra"] })]) }) }));
    mockTransaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
      fn({
        select: () => ({ from: () => ({ where: () => ({ for: () => Promise.resolve([{ locations: ["pmg"] }]) }) }) }),
        update: () => ({ set }),
      })
    );
    const res = await attempt({ location: "mirra" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ correct: true, memorizedAt: "Mirra", judge: "ai" });
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({ memorizationLocations: ["pmg", "Mirra"], longTermMemorized: false })
    );
  });

  it("503s when grading has no fallback left", async () => {
    cardIs(card());
    mockJudge.mockRejectedValue(new Error("no model"));
    const res = await attempt({});
    expect(res.status).toBe(503);
    expect(JSON.stringify(await res.json())).not.toContain("no model");
  });

  it("validates the body", async () => {
    expect((await attempt({ answer: "   " })).status).toBe(400);
    expect((await attempt({ attempt: 0 })).status).toBe(400);
    expect((await post("/api/knowledge/entries/not-a-uuid/recite", { location: "x", answer: "y" })).status).toBe(400);
  });
});
