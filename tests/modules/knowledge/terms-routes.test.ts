import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

// SHAN-712: GET /api/knowledge/terms is a public read of every card with a
// definition, newest first, shaped by buildTermIndex.

const { mockSelect, mockLimit } = vi.hoisted(() => ({
  mockSelect: vi.fn(),
  mockLimit: vi.fn(),
}));

vi.mock("@/modules/knowledge/classifier", () => ({ classifyNote: vi.fn() }));
vi.mock("@/modules/knowledge/bilibili", () => ({ postToBilibili: vi.fn() }));
vi.mock("@/modules/vocabulary/ai-enricher", () => ({ enrichWord: vi.fn() }));

vi.mock("@/db/client", () => ({ db: { select: mockSelect } }));

vi.mock("@/db/schema", () => ({
  vocabWords: { id: "vocabWords.id", updatedAt: "vocabWords.updatedAt" },
  vocabConnections: {},
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn(),
  and: vi.fn(),
  or: vi.fn(),
  desc: vi.fn(),
  ilike: vi.fn(),
  sql: vi.fn(),
  inArray: vi.fn(),
}));

vi.mock("@/modules/auth/middleware", () => ({
  optionalAuth: async (_c: any, next: any) => {
    await next();
  },
  requireAuth: async (c: any) => c.json({ error: "Unauthorized" }, 401),
  requireScope: () => async (_c: any, next: any) => {
    await next();
  },
}));

import { knowledgeRoutes } from "@/modules/knowledge/routes";
import { MAX_TERMS } from "@/modules/knowledge/terms";

const app = new Hono().route("/api/knowledge", knowledgeRoutes);

beforeEach(() => {
  vi.clearAllMocks();
  mockSelect.mockImplementation(() => ({
    from: () => ({ where: () => ({ orderBy: () => ({ limit: mockLimit }) }) }),
  }));
});

describe("GET /api/knowledge/terms", () => {
  it("answers without auth, with the index built from the rows", async () => {
    mockLimit.mockResolvedValue([
      {
        id: "11111111-1111-1111-1111-111111111111",
        word: "Data Subject Access Request (DSAR)",
        definition: "A request for the personal data a company holds about you.",
        category: "general",
        language: "general",
        partOfSpeech: "noun",
        pronunciation: null,
      },
    ]);
    const res = await app.request("/api/knowledge/terms");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.terms).toEqual([
      {
        id: "11111111-1111-1111-1111-111111111111",
        word: "Data Subject Access Request (DSAR)",
        match: ["Data Subject Access Request", "DSAR"],
        definition: "A request for the personal data a company holds about you.",
        category: "general",
        language: "general",
        partOfSpeech: "noun",
        pronunciation: null,
      },
    ]);
    expect(mockLimit).toHaveBeenCalledWith(MAX_TERMS);
  });

  it("returns an empty list when no card has a definition", async () => {
    mockLimit.mockResolvedValue([]);
    const res = await app.request("/api/knowledge/terms");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ terms: [] });
  });
});
