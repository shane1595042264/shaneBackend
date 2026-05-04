// tests/modules/journal/reactions-repo.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockTransaction, mockSelect } = vi.hoisted(() => ({
  mockTransaction: vi.fn(),
  mockSelect: vi.fn(),
}));

vi.mock("@/db/client", () => ({
  db: { transaction: mockTransaction, select: mockSelect },
}));
vi.mock("@/db/schema", () => ({ entryReactions: {}, commentReactions: {} }));
vi.mock("drizzle-orm", () => ({
  eq: vi.fn((c, v) => ({ c, v })),
  and: vi.fn((...a) => ({ and: a })),
  sql: vi.fn(() => ({ __sql: true })),
}));

function chain(rows: unknown[]) {
  const c: Record<string, unknown> = {};
  const t = Promise.resolve(rows);
  for (const m of ["from", "where", "limit", "groupBy"]) c[m] = vi.fn(() => c);
  Object.assign(c, { then: (r: any, j: any) => t.then(r, j) });
  return c;
}

import {
  toggleEntryReaction,
  toggleCommentReaction,
  summarizeEntryReactions,
  isAllowedEmoji,
  ALLOWED_EMOJI,
} from "@/modules/journal/reactions-repo";

beforeEach(() => vi.clearAllMocks());

describe("ALLOWED_EMOJI + isAllowedEmoji", () => {
  it("includes the 8 GitHub-style emoji", () => {
    expect(ALLOWED_EMOJI).toEqual(["+1", "-1", "laugh", "heart", "hooray", "rocket", "eyes", "confused"]);
  });

  it("rejects unknown emoji", () => {
    expect(isAllowedEmoji("smile")).toBe(false);
    expect(isAllowedEmoji("rocket")).toBe(true);
  });
});

describe("toggleEntryReaction", () => {
  it("inserts when no existing reaction (returns 'added')", async () => {
    const tx = {
      select: vi.fn(() => chain([])),
      insert: vi.fn(() => ({ values: vi.fn(() => Promise.resolve()) })),
      delete: vi.fn(),
    };
    mockTransaction.mockImplementation(async (fn: any) => fn(tx));
    expect(await toggleEntryReaction("u1", "e1", "rocket")).toBe("added");
    expect(tx.insert).toHaveBeenCalledTimes(1);
    expect(tx.delete).not.toHaveBeenCalled();
  });

  it("deletes when existing reaction (returns 'removed')", async () => {
    const tx = {
      select: vi.fn(() => chain([{ id: "r1" }])),
      delete: vi.fn(() => ({ where: vi.fn(() => Promise.resolve()) })),
      insert: vi.fn(),
    };
    mockTransaction.mockImplementation(async (fn: any) => fn(tx));
    expect(await toggleEntryReaction("u1", "e1", "rocket")).toBe("removed");
    expect(tx.delete).toHaveBeenCalledTimes(1);
    expect(tx.insert).not.toHaveBeenCalled();
  });
});

describe("toggleCommentReaction", () => {
  it("inserts when no existing reaction", async () => {
    const tx = {
      select: vi.fn(() => chain([])),
      insert: vi.fn(() => ({ values: vi.fn(() => Promise.resolve()) })),
      delete: vi.fn(),
    };
    mockTransaction.mockImplementation(async (fn: any) => fn(tx));
    expect(await toggleCommentReaction("u1", "c1", "heart")).toBe("added");
  });

  it("deletes when existing reaction", async () => {
    const tx = {
      select: vi.fn(() => chain([{ id: "r1" }])),
      delete: vi.fn(() => ({ where: vi.fn(() => Promise.resolve()) })),
      insert: vi.fn(),
    };
    mockTransaction.mockImplementation(async (fn: any) => fn(tx));
    expect(await toggleCommentReaction("u1", "c1", "heart")).toBe("removed");
  });
});

describe("summarizeEntryReactions", () => {
  it("returns counts per emoji", async () => {
    mockSelect.mockReturnValue(chain([
      { emoji: "rocket", count: 3 },
      { emoji: "heart", count: 1 },
    ]));
    const out = await summarizeEntryReactions("e1");
    expect(out).toEqual([
      { emoji: "rocket", count: 3 },
      { emoji: "heart", count: 1 },
    ]);
  });
});
