import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { __resetRateLimitBuckets } from "@/modules/shared/rate-limit";

// SHAN-604: every knowledge write that accepts a PAT is rate limited. Enrich
// sends an LLM request per call (10/min), card and connection writes share the
// 30/min card bucket with POST /entries, and comments have their own 30/min
// bucket. Rows are never found here, so each request that gets past the
// limiter ends in a cheap 404; the limiter counts it all the same.

const { mockSelect, mockEnrich, mockUpdateComment, mockDeleteComment } = vi.hoisted(() => ({
  mockSelect: vi.fn(),
  mockEnrich: vi.fn(),
  mockUpdateComment: vi.fn(),
  mockDeleteComment: vi.fn(),
}));

vi.mock("@/modules/knowledge/classifier", () => ({ classifyNote: vi.fn() }));
vi.mock("@/modules/knowledge/bilibili", () => ({ postToBilibili: vi.fn() }));
vi.mock("@/modules/vocabulary/ai-enricher", () => ({ enrichWord: mockEnrich }));

vi.mock("@/modules/knowledge/comments-repo", () => ({
  createComment: vi.fn(),
  getComment: vi.fn(),
  listForEntry: vi.fn(),
  updateComment: mockUpdateComment,
  deleteComment: mockDeleteComment,
}));

vi.mock("@/db/client", () => ({ db: { select: mockSelect } }));

vi.mock("@/db/schema", () => ({
  vocabWords: { id: "vocabWords.id", createdBy: "vocabWords.createdBy" },
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

// X-Test-Token flips the request from a JWT to a PAT (sets tokenId, which the
// limiter keys on). Scopes are granted generously so only the limiter decides.
vi.mock("@/modules/auth/middleware", () => ({
  optionalAuth: async (c: any, next: any) => {
    c.set("userId", null);
    c.set("tokenScopes", null);
    c.set("tokenId", null);
    await next();
  },
  requireAuth: async (c: any, next: any) => {
    const token = c.req.header("X-Test-Token") ?? null;
    c.set("userId", "user-1");
    c.set("tokenScopes", token ? ["knowledge:write", "comments:write"] : null);
    c.set("tokenId", token);
    await next();
  },
  requireScope: () => async (_c: any, next: any) => {
    await next();
  },
}));

import { knowledgeRoutes } from "@/modules/knowledge/routes";

const app = new Hono().route("/api/knowledge", knowledgeRoutes);

const ID = "11111111-1111-1111-1111-111111111111";
const ID2 = "22222222-2222-2222-2222-222222222222";

beforeEach(() => {
  vi.clearAllMocks();
  __resetRateLimitBuckets();
  const empty = () => Object.assign(Promise.resolve([]), { limit: () => Promise.resolve([]) });
  mockSelect.mockImplementation(() => ({ from: () => ({ where: empty }) }));
  mockUpdateComment.mockResolvedValue(null);
  mockDeleteComment.mockResolvedValue(false);
});

type Call = { method: string; path: string; body?: unknown };

const enrich: Call = { method: "POST", path: `/entries/${ID}/enrich` };

const cardWrites: Record<string, Call> = {
  "PUT /entries/:id": { method: "PUT", path: `/entries/${ID}`, body: { definition: "x" } },
  "DELETE /entries/:id": { method: "DELETE", path: `/entries/${ID}` },
  "POST /entries/bulk-delete": { method: "POST", path: "/entries/bulk-delete", body: { ids: [ID] } },
  "POST /connections": {
    method: "POST",
    path: "/connections",
    body: { fromWordId: ID, toWordId: ID2, connectionType: "related" },
  },
  "DELETE /connections/:id": { method: "DELETE", path: `/connections/${ID}` },
};

const commentWrites: Record<string, Call> = {
  "POST /entries/:id/comments": { method: "POST", path: `/entries/${ID}/comments`, body: { content: "hi" } },
  "PATCH /comments/:id": { method: "PATCH", path: `/comments/${ID}`, body: { content: "hi" } },
  "DELETE /comments/:id": { method: "DELETE", path: `/comments/${ID}` },
};

function send(call: Call, token: string | null = "tok-1") {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers["X-Test-Token"] = token;
  return app.request(`/api/knowledge${call.path}`, {
    method: call.method,
    headers,
    body: call.body === undefined ? undefined : JSON.stringify(call.body),
  });
}

async function sendTimes(call: Call, n: number, token: string | null = "tok-1") {
  for (let i = 0; i < n; i++) {
    const res = await send(call, token);
    expect(res.status).not.toBe(429);
  }
}

describe("POST /api/knowledge/entries/:id/enrich rate limit (SHAN-604)", () => {
  it("429s the 11th call in a minute from one PAT, before any lookup or LLM call", async () => {
    await sendTimes(enrich, 10);
    const selectsBefore = mockSelect.mock.calls.length;
    const res = await send(enrich);
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("60");
    expect(mockSelect.mock.calls.length).toBe(selectsBefore);
    expect(mockEnrich).not.toHaveBeenCalled();
  });

  it("counts each PAT separately", async () => {
    await sendTimes(enrich, 10, "tok-a");
    expect((await send(enrich, "tok-b")).status).toBe(404);
  });

  it("never limits a browser session", async () => {
    await sendTimes(enrich, 15, null);
  });

  it("does not share a bucket with card writes", async () => {
    await sendTimes(enrich, 10);
    expect((await send(cardWrites["PUT /entries/:id"])).status).toBe(404);
  });
});

describe("knowledge card and connection writes rate limit (SHAN-604)", () => {
  for (const [name, call] of Object.entries(cardWrites)) {
    it(`${name} 429s the 31st call in a minute from one PAT`, async () => {
      await sendTimes(call, 30);
      const res = await send(call);
      expect(res.status).toBe(429);
      expect(res.headers.get("Retry-After")).toBe("60");
    });
  }

  it("shares one 30/min bucket across card writes", async () => {
    await sendTimes(cardWrites["PUT /entries/:id"], 15);
    await sendTimes(cardWrites["DELETE /connections/:id"], 15);
    expect((await send(cardWrites["POST /entries/bulk-delete"])).status).toBe(429);
  });

  it("never limits a browser session", async () => {
    await sendTimes(cardWrites["DELETE /entries/:id"], 35, null);
  });
});

describe("knowledge comment writes rate limit (SHAN-604)", () => {
  for (const [name, call] of Object.entries(commentWrites)) {
    it(`${name} 429s the 31st call in a minute from one PAT`, async () => {
      await sendTimes(call, 30);
      const res = await send(call);
      expect(res.status).toBe(429);
      expect(res.headers.get("Retry-After")).toBe("60");
    });
  }

  it("does not share a bucket with card writes", async () => {
    await sendTimes(commentWrites["POST /entries/:id/comments"], 30);
    expect((await send(cardWrites["PUT /entries/:id"])).status).toBe(404);
  });
});
