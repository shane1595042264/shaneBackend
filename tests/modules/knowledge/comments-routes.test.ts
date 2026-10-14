// SHAN-574: a reply must hang off a top-level comment on the same entry,
// because that is the only shape the thread UI draws.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

const { mockSelect, mockCreateComment, mockGetComment } = vi.hoisted(() => ({
  mockSelect: vi.fn(),
  mockCreateComment: vi.fn(),
  mockGetComment: vi.fn(),
}));

vi.mock("@/modules/knowledge/classifier", () => ({ classifyNote: vi.fn() }));
vi.mock("@/modules/knowledge/bilibili", () => ({ postToBilibili: vi.fn() }));
vi.mock("@/modules/vocabulary/ai-enricher", () => ({ enrichWord: vi.fn() }));

vi.mock("@/modules/knowledge/comments-repo", () => ({
  createComment: mockCreateComment,
  getComment: mockGetComment,
  listForEntry: vi.fn(),
  updateComment: vi.fn(),
  deleteComment: vi.fn(),
}));

vi.mock("@/db/client", () => ({ db: { select: mockSelect } }));

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
  requireAuth: async (c: any, next: any) => {
    c.set("userId", "user-me");
    return next();
  },
  requireScope: () => async (_: any, next: any) => next(),
}));

import { knowledgeRoutes } from "@/modules/knowledge/routes";

const ENTRY_ID = "11111111-1111-1111-1111-111111111111";
const PARENT_ID = "22222222-2222-2222-2222-222222222222";

function entryExists() {
  const c: Record<string, unknown> = {};
  for (const m of ["from", "where"]) c[m] = vi.fn(() => c);
  c.limit = vi.fn(() => Promise.resolve([{ id: ENTRY_ID }]));
  mockSelect.mockReturnValue(c);
}

const app = new Hono().route("/api/knowledge", knowledgeRoutes);

function postReply() {
  return app.request(`/api/knowledge/entries/${ENTRY_ID}/comments`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: "reply", parent_comment_id: PARENT_ID }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  entryExists();
});

describe("POST /api/knowledge/entries/:id/comments parent check", () => {
  it("201s for a top-level parent on the same entry", async () => {
    mockGetComment.mockResolvedValue({ id: PARENT_ID, entryId: ENTRY_ID, parentCommentId: null });
    mockCreateComment.mockResolvedValue({ id: "c2" });
    const res = await postReply();
    expect(res.status).toBe(201);
    expect(mockCreateComment).toHaveBeenCalledWith(
      expect.objectContaining({ entryId: ENTRY_ID, parentCommentId: PARENT_ID }),
    );
  });

  it.each([
    ["does not exist", null],
    ["is on another entry", { id: PARENT_ID, entryId: "other", parentCommentId: null }],
    ["is itself a reply", { id: PARENT_ID, entryId: ENTRY_ID, parentCommentId: "p0" }],
  ])("400s when the parent %s", async (_label, parent) => {
    mockGetComment.mockResolvedValue(parent);
    const res = await postReply();
    expect(res.status).toBe(400);
    expect(mockCreateComment).not.toHaveBeenCalled();
  });

  it("skips the lookup for a top-level comment", async () => {
    mockCreateComment.mockResolvedValue({ id: "c1" });
    const res = await app.request(`/api/knowledge/entries/${ENTRY_ID}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "hi" }),
    });
    expect(res.status).toBe(201);
    expect(mockGetComment).not.toHaveBeenCalled();
  });
});
