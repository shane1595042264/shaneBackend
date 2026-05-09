// tests/modules/journal/comments-repo.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockSelect, mockInsert, mockUpdate, mockDelete } = vi.hoisted(() => ({
  mockSelect: vi.fn(),
  mockInsert: vi.fn(),
  mockUpdate: vi.fn(),
  mockDelete: vi.fn(),
}));

vi.mock("@/db/client", () => ({
  db: { select: mockSelect, insert: mockInsert, update: mockUpdate, delete: mockDelete },
}));
vi.mock("@/db/schema", () => ({ journalComments: {}, journalEntries: {}, users: {} }));
vi.mock("drizzle-orm", () => ({
  eq: vi.fn((c, v) => ({ c, v })),
  and: vi.fn((...a) => ({ and: a })),
  asc: vi.fn((c) => ({ c, dir: "asc" })),
  getTableColumns: vi.fn(() => ({})),
}));

function chain(rows: unknown[]) {
  const c: Record<string, unknown> = {};
  const t = Promise.resolve(rows);
  for (const m of ["from", "where", "orderBy", "limit", "innerJoin", "leftJoin"]) c[m] = vi.fn(() => c);
  Object.assign(c, { then: (r: any, j: any) => t.then(r, j) });
  return c;
}

import { createComment, listForEntry, getComment, updateComment, deleteComment } from "@/modules/journal/comments-repo";

beforeEach(() => vi.clearAllMocks());

describe("createComment", () => {
  it("inserts and returns the row", async () => {
    mockInsert.mockReturnValue({
      values: vi.fn(() => ({
        returning: vi.fn(() => Promise.resolve([{ id: "c1", entryId: "e1", authorId: "u1", content: "hi" }])),
      })),
    });
    const out = await createComment({ entryId: "e1", authorId: "u1", content: "hi" });
    expect(out.id).toBe("c1");
  });
});

describe("listForEntry", () => {
  it("attaches author { id, name, avatarUrl } from the joined users row", async () => {
    mockSelect.mockReturnValue(chain([
      { id: "c1", authorId: "u1", authorName: "Alice", authorAvatarUrl: "https://img/a.png" },
      { id: "c2", authorId: "u2", authorName: null, authorAvatarUrl: null },
    ]));
    const out = await listForEntry("e1");
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ id: "c1", authorId: "u1", author: { id: "u1", name: "Alice", avatarUrl: "https://img/a.png" } });
    expect(out[1].author).toEqual({ id: "u2", name: null, avatarUrl: null });
    // Joined columns are stripped from the top level
    expect("authorName" in out[0]).toBe(false);
    expect("authorAvatarUrl" in out[0]).toBe(false);
  });

  it("sets author to null when authorId is missing", async () => {
    mockSelect.mockReturnValue(chain([
      { id: "c1", authorId: null, authorName: null, authorAvatarUrl: null },
    ]));
    const out = await listForEntry("e1");
    expect(out[0].author).toBeNull();
  });
});

describe("getComment", () => {
  it("returns null when not found", async () => {
    mockSelect.mockReturnValue(chain([]));
    expect(await getComment("missing")).toBeNull();
  });
});

describe("updateComment", () => {
  it("updates only when caller is author (returns row)", async () => {
    mockUpdate.mockReturnValue({
      set: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: vi.fn(() => Promise.resolve([{ id: "c1", content: "edited", editedAt: new Date() }])),
        })),
      })),
    });
    const out = await updateComment("c1", "u1", "edited");
    expect(out?.content).toBe("edited");
    expect(out?.editedAt).toBeInstanceOf(Date);
  });

  it("returns null when no row matched (caller not author)", async () => {
    mockUpdate.mockReturnValue({
      set: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: vi.fn(() => Promise.resolve([])),
        })),
      })),
    });
    expect(await updateComment("c1", "wrong", "x")).toBeNull();
  });
});

describe("deleteComment", () => {
  it("deletes when caller is comment author", async () => {
    mockSelect.mockReturnValue(chain([{ commentId: "c1", commentAuthor: "u1", entryAuthor: "owner" }]));
    mockDelete.mockReturnValue({ where: vi.fn(() => Promise.resolve()) });
    expect(await deleteComment("c1", "u1")).toBe(true);
  });

  it("deletes when caller is entry author (even though they didn't write the comment)", async () => {
    mockSelect.mockReturnValue(chain([{ commentId: "c1", commentAuthor: "u1", entryAuthor: "owner" }]));
    mockDelete.mockReturnValue({ where: vi.fn(() => Promise.resolve()) });
    expect(await deleteComment("c1", "owner")).toBe(true);
  });

  it("refuses when caller is neither comment author nor entry author", async () => {
    mockSelect.mockReturnValue(chain([{ commentId: "c1", commentAuthor: "u1", entryAuthor: "owner" }]));
    expect(await deleteComment("c1", "stranger")).toBe(false);
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it("returns false when comment doesn't exist", async () => {
    mockSelect.mockReturnValue(chain([]));
    expect(await deleteComment("c1", "u1")).toBe(false);
  });
});
