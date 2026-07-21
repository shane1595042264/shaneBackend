import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

const { mockSelect, mockInsert, mockClassify, mockPostBilibili } = vi.hoisted(() => ({
  mockSelect: vi.fn(),
  mockInsert: vi.fn(),
  mockClassify: vi.fn(),
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
    select: mockSelect,
    insert: mockInsert,
  },
}));

vi.mock("@/db/schema", () => ({
  vocabWords: { id: "vw_id_col" },
  vocabConnections: {},
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((c: unknown, v: unknown) => ({ c, v })),
  and: vi.fn((...args: unknown[]) => ({ and: args })),
  or: vi.fn((...args: unknown[]) => ({ or: args })),
  desc: vi.fn((c: unknown) => ({ c, dir: "desc" })),
  ilike: vi.fn(),
  sql: vi.fn(),
  inArray: vi.fn((c: unknown, vs: unknown) => ({ inArray: { c, vs } })),
}));

vi.mock("@/modules/auth/middleware", () => ({
  optionalAuth: async (_: any, next: any) => next(),
  requireAuth: async (_: any, next: any) => next(),
  requireScope: () => async (_: any, next: any) => next(),
}));

vi.mock("@/modules/vocabulary/ai-enricher", () => ({
  enrichWord: vi.fn(),
}));

import { knowledgeRoutes } from "@/modules/knowledge/routes";

function selectChain(rows: unknown[]) {
  const c: Record<string, unknown> = {};
  const t = Promise.resolve(rows);
  for (const m of ["from", "where"]) c[m] = vi.fn(() => c);
  Object.assign(c, { then: (r: any, j: any) => t.then(r, j) });
  return c;
}

function insertReturning(rows: unknown[] | (() => Promise<unknown[]>)) {
  mockInsert.mockImplementation(() => ({
    values: () => ({
      returning: () => (typeof rows === "function" ? rows() : Promise.resolve(rows)),
    }),
  }));
}

beforeEach(() => vi.clearAllMocks());

const app = new Hono().route("/api/knowledge", knowledgeRoutes);

const FROM_ID = "11111111-1111-1111-1111-111111111111";
const TO_ID = "22222222-2222-2222-2222-222222222222";
const validBody = {
  fromWordId: FROM_ID,
  toWordId: TO_ID,
  connectionType: "related" as const,
};

describe("POST /api/knowledge/connections — existence gating", () => {
  it("returns 201 when both word IDs exist", async () => {
    mockSelect.mockReturnValue(selectChain([{ id: FROM_ID }, { id: TO_ID }]));
    insertReturning([{ id: "c1", ...validBody }]);
    const res = await app.request("/api/knowledge/connections", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validBody),
    });
    expect(res.status).toBe(201);
    expect(mockInsert).toHaveBeenCalled();
  });

  it("returns 404 when fromWordId does not exist (toWordId present)", async () => {
    mockSelect.mockReturnValue(selectChain([{ id: TO_ID }]));
    const res = await app.request("/api/knowledge/connections", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validBody),
    });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe(`Word not found: ${FROM_ID}`);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("returns 404 when toWordId does not exist (fromWordId present)", async () => {
    mockSelect.mockReturnValue(selectChain([{ id: FROM_ID }]));
    const res = await app.request("/api/knowledge/connections", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validBody),
    });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe(`Word not found: ${TO_ID}`);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("returns 404 when neither id exists", async () => {
    mockSelect.mockReturnValue(selectChain([]));
    const res = await app.request("/api/knowledge/connections", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validBody),
    });
    expect(res.status).toBe(404);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("returns 400 on self-connect without hitting the DB", async () => {
    const res = await app.request("/api/knowledge/connections", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...validBody, toWordId: FROM_ID }),
    });
    expect(res.status).toBe(400);
    expect(mockSelect).not.toHaveBeenCalled();
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("preserves 409 on duplicate connection (unique violation)", async () => {
    mockSelect.mockReturnValue(selectChain([{ id: FROM_ID }, { id: TO_ID }]));
    insertReturning(() => {
      const err: any = new Error("dup");
      err.code = "23505";
      return Promise.reject(err);
    });
    const res = await app.request("/api/knowledge/connections", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validBody),
    });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("This connection already exists");
  });
});

describe("POST /api/knowledge/connections — note bound (SHAN-412)", () => {
  it("rejects a note longer than 1000 chars with 400 and never hits the DB", async () => {
    const res = await app.request("/api/knowledge/connections", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...validBody, note: "x".repeat(1001) }),
    });
    expect(res.status).toBe(400);
    expect(mockSelect).not.toHaveBeenCalled();
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("accepts a note at exactly 1000 chars", async () => {
    mockSelect.mockReturnValue(selectChain([{ id: FROM_ID }, { id: TO_ID }]));
    insertReturning([{ id: "c1", ...validBody }]);
    const res = await app.request("/api/knowledge/connections", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...validBody, note: "x".repeat(1000) }),
    });
    expect(res.status).toBe(201);
    expect(mockInsert).toHaveBeenCalled();
  });
});
