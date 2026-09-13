// tests/modules/blog/comments-repo.test.ts — SHAN-488 Phase 4
//
// What is actually new here is not the insert, it's the denormalized
// blog_posts.comment_count: it has to move in the same transaction as the row
// it counts, the decrement has to be floored at 0, and a delete the caller was
// not entitled to must not touch it at all. Those are the assertions below.
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockSelect, mockUpdate, mockTransaction } = vi.hoisted(() => ({
  mockSelect: vi.fn(),
  mockUpdate: vi.fn(),
  mockTransaction: vi.fn(),
}));

vi.mock("@/db/client", () => ({
  db: { select: mockSelect, update: mockUpdate, transaction: mockTransaction },
}));

vi.mock("@/db/schema", () => {
  const table = (name: string) =>
    new Proxy({} as Record<string, unknown>, {
      get: (_t, prop) => ({ table: name, column: String(prop) }),
    });
  return {
    blogComments: table("blog_comments"),
    blogPosts: table("blog_posts"),
    users: table("users"),
  };
});

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((c: unknown, v: unknown) => ({ eq: [c, v] })),
  and: vi.fn((...a: unknown[]) => ({ and: a })),
  asc: vi.fn((c: unknown) => ({ c, dir: "asc" })),
  sql: Object.assign(
    vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({
      __sql: strings.join("?"),
      values,
    })),
    { raw: vi.fn() }
  ),
}));

function chain(rows: unknown[]) {
  const c: Record<string, unknown> = {};
  const t = Promise.resolve(rows);
  for (const m of ["from", "where", "orderBy", "limit", "leftJoin", "innerJoin", "values", "set", "returning"]) {
    c[m] = vi.fn(() => c);
  }
  Object.assign(c, { then: (r: any, j: any) => t.then(r, j) });
  return c;
}

import { createComment, deleteComment, listForPost } from "@/modules/blog/comments-repo";

beforeEach(() => vi.clearAllMocks());

describe("createComment", () => {
  it("inserts the comment and bumps comment_count inside one transaction", async () => {
    const insertChain = chain([{ id: "c1", content: "hi" }]);
    const updateChain = chain([]);
    const tx = {
      insert: vi.fn(() => insertChain),
      update: vi.fn(() => updateChain),
    };
    mockTransaction.mockImplementation(async (fn: any) => fn(tx));

    const row = await createComment({
      postId: "p1",
      authorId: "u2",
      authorTimezone: "Europe/Athens",
      content: "hi",
    });

    expect(row).toEqual({ id: "c1", content: "hi" });
    // Both halves go through the same tx handle — not db — or a failed count
    // bump would leave the tile lying about the thread.
    expect(tx.insert).toHaveBeenCalledTimes(1);
    expect(tx.update).toHaveBeenCalledTimes(1);
    expect(insertChain.values).toHaveBeenCalledWith(
      expect.objectContaining({ postId: "p1", authorId: "u2", content: "hi" })
    );
    expect(updateChain.set).toHaveBeenCalledWith(
      expect.objectContaining({ commentCount: expect.anything() })
    );
  });

  it("falls back to a default timezone when the caller has none", async () => {
    const insertChain = chain([{ id: "c1" }]);
    const tx = { insert: vi.fn(() => insertChain), update: vi.fn(() => chain([])) };
    mockTransaction.mockImplementation(async (fn: any) => fn(tx));

    await createComment({ postId: "p1", authorId: "u2", content: "hi" });

    expect(insertChain.values).toHaveBeenCalledWith(
      expect.objectContaining({ authorTimezone: "America/Chicago" })
    );
  });
});

describe("deleteComment", () => {
  const row = (over: Record<string, unknown> = {}) => ({
    commentAuthor: "u2",
    postId: "p1",
    postAuthor: "u1",
    ...over,
  });

  function txFor(selectRows: unknown[], deletedRows: unknown[]) {
    const deleteChain = chain(deletedRows);
    const updateChain = chain([]);
    const tx = {
      select: vi.fn(() => chain(selectRows)),
      delete: vi.fn(() => deleteChain),
      update: vi.fn(() => updateChain),
    };
    mockTransaction.mockImplementation(async (fn: any) => fn(tx));
    return { tx, deleteChain, updateChain };
  }

  it("lets the comment author delete and decrements the count", async () => {
    const { tx, updateChain } = txFor([row()], [{ id: "c1" }]);
    expect(await deleteComment("c1", "u2")).toBe(true);
    expect(tx.delete).toHaveBeenCalledTimes(1);
    expect(updateChain.set).toHaveBeenCalledWith(
      expect.objectContaining({ commentCount: expect.anything() })
    );
  });

  it("lets the POST author delete someone else's comment (moderation)", async () => {
    const { tx } = txFor([row()], [{ id: "c1" }]);
    expect(await deleteComment("c1", "u1")).toBe(true);
    expect(tx.delete).toHaveBeenCalledTimes(1);
  });

  it("refuses a third party and leaves the count alone", async () => {
    const { tx } = txFor([row()], [{ id: "c1" }]);
    expect(await deleteComment("c1", "u9")).toBe(false);
    expect(tx.delete).not.toHaveBeenCalled();
    expect(tx.update).not.toHaveBeenCalled();
  });

  it("returns false for an unknown comment without touching anything", async () => {
    const { tx } = txFor([], []);
    expect(await deleteComment("nope", "u1")).toBe(false);
    expect(tx.delete).not.toHaveBeenCalled();
    expect(tx.update).not.toHaveBeenCalled();
  });

  it("does NOT decrement when the DELETE removed nothing (lost race)", async () => {
    // Two concurrent deletes both pass the authorization SELECT; only the one
    // whose DELETE actually removed a row may decrement, or the count drifts
    // below the real number of comments.
    const { tx } = txFor([row()], []);
    expect(await deleteComment("c1", "u2")).toBe(false);
    expect(tx.update).not.toHaveBeenCalled();
  });

  it("floors the decrement at zero", async () => {
    const { updateChain } = txFor([row()], [{ id: "c1" }]);
    await deleteComment("c1", "u2");
    const arg = (updateChain.set as any).mock.calls[0][0];
    expect(String(arg.commentCount.__sql)).toContain("greatest(0,");
  });
});

describe("listForPost", () => {
  it("flattens the joined user columns into an author object", async () => {
    mockSelect.mockReturnValue(
      chain([
        {
          id: "c1",
          postId: "p1",
          authorId: "u2",
          authorTimezone: "Europe/Athens",
          content: "hi",
          editedAt: null,
          createdAt: new Date("2026-09-10T00:00:00.000Z"),
          updatedAt: new Date("2026-09-10T00:00:00.000Z"),
          authorName: "Ava",
          authorAvatarUrl: "https://example.test/a.png",
        },
      ])
    );

    const [comment] = await listForPost("p1");

    expect(comment.author).toEqual({
      id: "u2",
      name: "Ava",
      avatarUrl: "https://example.test/a.png",
    });
    // The raw join columns must not leak into the API payload.
    expect(comment).not.toHaveProperty("authorName");
    expect(comment).not.toHaveProperty("authorAvatarUrl");
  });
});
