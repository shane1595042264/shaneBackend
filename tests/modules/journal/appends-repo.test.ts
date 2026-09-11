import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockSelect, mockInsert, mockUpdate } = vi.hoisted(() => ({
  mockSelect: vi.fn(),
  mockInsert: vi.fn(),
  mockUpdate: vi.fn(),
}));

vi.mock("@/db/client", () => ({
  db: { select: mockSelect, insert: mockInsert, update: mockUpdate },
}));
vi.mock("@/db/schema", () => ({
  journalAppends: {
    entryId: {},
    authorId: {},
    content: {},
    createdAt: {},
    editedAt: {},
    deletedAt: {},
    id: {},
  },
  users: { id: {}, name: {}, avatarUrl: {} },
}));
vi.mock("drizzle-orm", () => ({
  and: vi.fn((...conds: unknown[]) => ({ and: conds })),
  asc: vi.fn((c: unknown) => ({ c, dir: "asc" })),
  eq: vi.fn((c: unknown, v: unknown) => ({ c, v })),
  isNull: vi.fn((c: unknown) => ({ isNull: c })),
}));

import {
  createAppend,
  listAppendsForEntry,
  updateAppend,
  softDeleteAppend,
} from "@/modules/journal/appends-repo";

/** Builds a db.update(...).set(...).where(...).returning() chain. */
function updateChain(rows: unknown[]) {
  return {
    set: vi.fn(() => ({
      where: vi.fn(() => ({ returning: vi.fn(() => Promise.resolve(rows)) })),
    })),
  };
}

beforeEach(() => vi.clearAllMocks());

describe("createAppend", () => {
  it("inserts a new row and returns it", async () => {
    const expected = { id: "a1", entryId: "e1", authorId: "u1", content: "more", createdAt: new Date() };
    mockInsert.mockReturnValue({
      values: vi.fn(() => ({
        returning: vi.fn(() => Promise.resolve([expected])),
      })),
    });

    const row = await createAppend({ entryId: "e1", authorId: "u1", content: "more" });
    expect(row).toEqual(expected);
    expect(mockInsert).toHaveBeenCalledTimes(1);
  });
});

describe("listAppendsForEntry", () => {
  it("returns rows joined with users, ordered by createdAt asc", async () => {
    const rows = [
      { id: "a1", entryId: "e1", authorId: "u1", content: "one", createdAt: new Date("2026-05-11T08:00:00Z"), authorName: "Alice", authorAvatarUrl: null },
      { id: "a2", entryId: "e1", authorId: "u1", content: "two", createdAt: new Date("2026-05-11T09:00:00Z"), authorName: "Alice", authorAvatarUrl: null },
    ];
    const chain: Record<string, unknown> = {};
    const promise = Promise.resolve(rows);
    for (const m of ["from", "leftJoin", "where", "orderBy"]) chain[m] = vi.fn(() => chain);
    Object.assign(chain, { then: (r: any, j: any) => promise.then(r, j) });
    mockSelect.mockReturnValue(chain);

    const result = await listAppendsForEntry("e1");
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      id: "a1",
      content: "one",
      author: { id: "u1", name: "Alice", avatarUrl: null },
    });
    expect((result[0] as any).authorName).toBeUndefined();
  });

  it("returns empty list when no appends", async () => {
    const chain: Record<string, unknown> = {};
    const promise = Promise.resolve([]);
    for (const m of ["from", "leftJoin", "where", "orderBy"]) chain[m] = vi.fn(() => chain);
    Object.assign(chain, { then: (r: any, j: any) => promise.then(r, j) });
    mockSelect.mockReturnValue(chain);

    const result = await listAppendsForEntry("e1");
    expect(result).toEqual([]);
  });
});

describe("updateAppend", () => {
  it("returns the updated row", async () => {
    const expected = { id: "a1", entryId: "e1", authorId: "u1", content: "fixed", editedAt: new Date() };
    mockUpdate.mockReturnValue(updateChain([expected]));

    const row = await updateAppend({ id: "a1", entryId: "e1", authorId: "u1", content: "fixed" });
    expect(row).toEqual(expected);
  });

  it("returns null when nothing matched (wrong author, wrong entry, or already deleted)", async () => {
    mockUpdate.mockReturnValue(updateChain([]));
    const row = await updateAppend({ id: "a1", entryId: "e1", authorId: "not-the-author", content: "x" });
    expect(row).toBeNull();
  });

  it("stamps editedAt", async () => {
    const set = vi.fn(() => ({
      where: vi.fn(() => ({ returning: vi.fn(() => Promise.resolve([{ id: "a1" }])) })),
    }));
    mockUpdate.mockReturnValue({ set });
    await updateAppend({ id: "a1", entryId: "e1", authorId: "u1", content: "fixed" });
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({ content: "fixed", editedAt: expect.any(Date) })
    );
  });
});

describe("softDeleteAppend", () => {
  it("stamps deletedAt rather than deleting the row", async () => {
    const set = vi.fn(() => ({
      where: vi.fn(() => ({ returning: vi.fn(() => Promise.resolve([{ id: "a1" }])) })),
    }));
    mockUpdate.mockReturnValue({ set });

    const row = await softDeleteAppend({ id: "a1", entryId: "e1", authorId: "u1" });
    expect(row).toEqual({ id: "a1" });
    expect(set).toHaveBeenCalledWith({ deletedAt: expect.any(Date) });
    // Soft delete: the repo never issues a db.delete for appends.
    expect(mockUpdate).toHaveBeenCalledTimes(1);
  });

  it("returns null on a second delete so the route 404s instead of double-logging", async () => {
    mockUpdate.mockReturnValue(updateChain([]));
    const row = await softDeleteAppend({ id: "a1", entryId: "e1", authorId: "u1" });
    expect(row).toBeNull();
  });
});
