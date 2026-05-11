import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockSelect, mockInsert } = vi.hoisted(() => ({
  mockSelect: vi.fn(),
  mockInsert: vi.fn(),
}));

vi.mock("@/db/client", () => ({
  db: { select: mockSelect, insert: mockInsert },
}));
vi.mock("@/db/schema", () => ({
  journalAppends: { entryId: {}, authorId: {}, content: {}, createdAt: {}, id: {} },
  users: { id: {}, name: {}, avatarUrl: {} },
}));
vi.mock("drizzle-orm", () => ({
  asc: vi.fn((c: unknown) => ({ c, dir: "asc" })),
  eq: vi.fn((c: unknown, v: unknown) => ({ c, v })),
}));

import { createAppend, listAppendsForEntry } from "@/modules/journal/appends-repo";

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
