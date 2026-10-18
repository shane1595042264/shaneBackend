// tests/modules/blog/reactions-repo.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockTransaction } = vi.hoisted(() => ({ mockTransaction: vi.fn() }));

vi.mock("@/db/client", () => ({ db: { transaction: mockTransaction, select: vi.fn() } }));
vi.mock("@/db/schema", () => ({ blogPostReactions: {}, entryReactions: {}, commentReactions: {} }));
vi.mock("drizzle-orm", () => ({
  eq: vi.fn((c, v) => ({ c, v })),
  and: vi.fn((...a) => ({ and: a })),
  sql: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({ __sql: strings.join("?"), values })),
}));

function chain(rows: unknown[]) {
  const c: Record<string, unknown> = {};
  const t = Promise.resolve(rows);
  for (const m of ["from", "where", "limit"]) c[m] = vi.fn(() => c);
  Object.assign(c, { then: (r: any, j: any) => t.then(r, j) });
  return c;
}

import { togglePostReaction } from "@/modules/blog/reactions-repo";

beforeEach(() => vi.clearAllMocks());

describe("togglePostReaction", () => {
  // SHAN-591: without the lock, two concurrent toggles both insert and the
  // second 500s on blog_post_reactions_user_id_post_id_emoji_unique.
  it("locks on a post-scoped key before reading, then inserts", async () => {
    const order: string[] = [];
    const tx = {
      execute: vi.fn(() => { order.push("lock"); return Promise.resolve(); }),
      select: vi.fn(() => { order.push("select"); return chain([]); }),
      insert: vi.fn(() => ({ values: vi.fn(() => Promise.resolve()) })),
      delete: vi.fn(),
    };
    mockTransaction.mockImplementation(async (fn: any) => fn(tx));
    expect(await togglePostReaction("u1", "p1", "heart")).toBe("added");
    expect(order).toEqual(["lock", "select"]);
    const lockSql = (tx.execute.mock.calls[0] as unknown[])[0] as { values: unknown[] };
    expect(lockSql.values).toEqual(["post:u1:p1:heart"]);
  });

  it("removes an existing reaction", async () => {
    const tx = {
      execute: vi.fn(() => Promise.resolve()),
      select: vi.fn(() => chain([{ id: "r1" }])),
      delete: vi.fn(() => ({ where: vi.fn(() => Promise.resolve()) })),
      insert: vi.fn(),
    };
    mockTransaction.mockImplementation(async (fn: any) => fn(tx));
    expect(await togglePostReaction("u1", "p1", "heart")).toBe("removed");
    expect(tx.insert).not.toHaveBeenCalled();
  });

  it("returns null when the post was deleted mid-toggle (FK violation)", async () => {
    mockTransaction.mockRejectedValue(Object.assign(new Error("fk"), { cause: { code: "23503" } }));
    expect(await togglePostReaction("u1", "p1", "heart")).toBeNull();
  });
});
