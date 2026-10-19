import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

const { mockSelect, mockInsert, mockDelete, mockQueueNote } = vi.hoisted(() => ({
  mockSelect: vi.fn(),
  mockInsert: vi.fn(),
  mockDelete: vi.fn(),
  mockQueueNote: vi.fn(),
}));

vi.mock("@/db/client", () => ({ db: { select: mockSelect, insert: mockInsert, delete: mockDelete } }));
vi.mock("@/db/schema", () => ({
  readerNotes: {
    id: "rn.id",
    userId: "rn.userId",
    surface: "rn.surface",
    resourceId: "rn.resourceId",
    parentId: "rn.parentId",
    createdAt: "rn.createdAt",
  },
}));
vi.mock("drizzle-orm", () => ({
  and: vi.fn((...a: unknown[]) => ({ and: a })),
  eq: vi.fn((c: unknown, v: unknown) => ({ eq: [c, v] })),
  asc: vi.fn((c: unknown) => ({ asc: c })),
}));
vi.mock("@/modules/knowledge/ingest", () => ({ queueNoteForKnowledge: mockQueueNote }));
vi.mock("@/modules/auth/middleware", () => ({
  requireAuth: async (c: any, next: any) => {
    const u = c.req.header("X-Test-User");
    if (!u) return c.json({ error: "auth" }, 401);
    c.set("userId", u);
    c.set("tokenScopes", c.req.header("X-Test-Token") ? [] : null);
    await next();
  },
  requireBrowserSession: () => async (c: any, next: any) => {
    if (c.get("tokenScopes") !== null) return c.json({ error: "browser only" }, 403);
    await next();
  },
}));

import { eq } from "drizzle-orm";
import { readerNotesRoutes } from "@/modules/reader-notes/routes";

const app = new Hono().route("/api/reader-notes", readerNotesRoutes);
const POST_ID = "22222222-2222-4222-8222-222222222222";
const NOTE_ID = "33333333-3333-4333-8333-333333333333";
const anchor = { target: "body", quote: "idempotent" };

function selectReturns(rows: unknown[]) {
  const chain: Record<string, unknown> = {};
  for (const m of ["from", "where", "orderBy"]) chain[m] = vi.fn(() => chain);
  Object.assign(chain, { then: (r: any, j: any) => Promise.resolve(rows).then(r, j) });
  mockSelect.mockReturnValueOnce(chain);
}

let inserted: Record<string, unknown> | null = null;
beforeEach(() => {
  vi.clearAllMocks();
  inserted = null;
  mockInsert.mockReturnValue({
    values: (v: Record<string, unknown>) => {
      inserted = v;
      return { returning: () => Promise.resolve([{ id: NOTE_ID, ...v }]) };
    },
  });
});

const post = (body: unknown, headers: Record<string, string> = { "X-Test-User": "u1" }) =>
  app.request("/api/reader-notes", { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });

describe("reader notes", () => {
  it("lists only the caller's notes on one resource", async () => {
    selectReturns([{ id: NOTE_ID }]);
    const res = await app.request(`/api/reader-notes?surface=blog&resource=${POST_ID}`, { headers: { "X-Test-User": "u1" } });
    expect(res.status).toBe(200);
    expect(vi.mocked(eq)).toHaveBeenCalledWith("rn.userId", "u1");
  });

  it("refuses PATs and signed-out callers", async () => {
    expect((await post({ surface: "blog", resource: POST_ID, content: "x", anchor }, {})).status).toBe(401);
    expect((await post({ surface: "blog", resource: POST_ID, content: "x", anchor }, { "X-Test-User": "u1", "X-Test-Token": "t" })).status).toBe(403);
  });

  it("creates a note with its AI stamp and queues it for knowledge", async () => {
    const meta = { kind: "ai", provider: "openai", model: "gpt-5-nano" };
    const res = await post({ surface: "blog", resource: POST_ID.toUpperCase(), content: "Same result twice.", anchor, meta });
    expect(res.status).toBe(201);
    expect(inserted).toMatchObject({ userId: "u1", surface: "blog", resourceId: POST_ID, meta, parentId: null });
    expect(mockQueueNote).toHaveBeenCalledWith({ userId: "u1", quote: "idempotent", content: "Same result twice.", app: "blog" });
  });

  it("needs an anchor on a note and forbids one on a reply", async () => {
    expect((await post({ surface: "knowledge", resource: POST_ID, content: "x" })).status).toBe(400);
    expect((await post({ surface: "knowledge", resource: POST_ID, content: "x", anchor, parentId: NOTE_ID })).status).toBe(400);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("only replies under your own top-level note on the same page", async () => {
    selectReturns([]);
    expect((await post({ surface: "blog", resource: POST_ID, content: "x", parentId: NOTE_ID })).status).toBe(400);
    selectReturns([{ id: NOTE_ID, parentId: null, resourceId: POST_ID, surface: "blog" }]);
    const res = await post({ surface: "blog", resource: POST_ID, content: "reply", parentId: NOTE_ID });
    expect(res.status).toBe(201);
    expect(inserted).toMatchObject({ parentId: NOTE_ID, anchor: null });
    expect(mockQueueNote).not.toHaveBeenCalled();
  });

  it("deletes only the caller's own note", async () => {
    mockDelete.mockReturnValueOnce({ where: () => ({ returning: () => Promise.resolve([]) }) });
    const res = await app.request(`/api/reader-notes/${NOTE_ID}`, { method: "DELETE", headers: { "X-Test-User": "u1" } });
    expect(res.status).toBe(404);
  });
});
