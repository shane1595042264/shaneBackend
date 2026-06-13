import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockSelect, mockInsert, mockDelete, mockUpdate } = vi.hoisted(() => ({
  mockSelect: vi.fn(),
  mockInsert: vi.fn(),
  mockDelete: vi.fn(),
  mockUpdate: vi.fn(),
}));

vi.mock("@/db/client", () => ({
  db: { select: mockSelect, insert: mockInsert, delete: mockDelete, update: mockUpdate },
}));
vi.mock("@/db/schema", () => ({
  teaEntries: {
    id: {},
    authorId: {},
    title: {},
    createdAt: {},
    updatedAt: {},
  },
}));
vi.mock("drizzle-orm", () => ({
  eq: vi.fn((c: unknown, v: unknown) => ({ c, v })),
  and: vi.fn((...args: unknown[]) => ({ and: args })),
  desc: vi.fn((c: unknown) => ({ c, dir: "desc" })),
  sql: Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => ({ kind: "sql", strings, values }),
    { raw: (s: string) => ({ kind: "sql-raw", s }) },
  ),
}));

function chain(rows: unknown[]) {
  const c: Record<string, unknown> = {};
  const t = Promise.resolve(rows);
  for (const m of ["from", "where", "orderBy", "limit"]) c[m] = vi.fn(() => c);
  Object.assign(c, { then: (r: any, j: any) => t.then(r, j) });
  return c;
}

import {
  createTeaEntry,
  deleteTeaEntry,
  getTeaEntryById,
  listTeaEntriesForAuthor,
  updateTeaEntry,
  verifyPin,
} from "@/modules/tea-entries/repo";

beforeEach(() => vi.clearAllMocks());

describe("verifyPin", () => {
  it("returns true on exact match", () => {
    expect(verifyPin("1234", "1234")).toBe(true);
  });
  it("returns false on mismatch", () => {
    expect(verifyPin("1234", "5678")).toBe(false);
  });
  it("returns false on length mismatch (no throw)", () => {
    expect(verifyPin("123", "1234")).toBe(false);
    expect(verifyPin("12345", "1234")).toBe(false);
  });
});

describe("createTeaEntry", () => {
  it("inserts and returns the row", async () => {
    const insertChain = {
      values: vi.fn(() => ({
        returning: vi.fn(() =>
          Promise.resolve([
            {
              id: "tea-1",
              authorId: "user-1",
              authorTimezone: "America/Chicago",
              title: null,
              content: "secret",
              pin: "1234",
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          ]),
        ),
      })),
    };
    mockInsert.mockReturnValue(insertChain);
    const out = await createTeaEntry({
      authorId: "user-1",
      authorTimezone: "America/Chicago",
      title: null,
      content: "secret",
      pin: "1234",
    });
    expect(out.id).toBe("tea-1");
    expect(out.pin).toBe("1234");
    expect(insertChain.values).toHaveBeenCalledWith(
      expect.objectContaining({ authorId: "user-1", content: "secret", pin: "1234" }),
    );
  });
});

describe("getTeaEntryById", () => {
  it("returns null when missing", async () => {
    mockSelect.mockReturnValue(chain([]));
    expect(await getTeaEntryById("00000000-0000-0000-0000-000000000000")).toBeNull();
  });
  it("returns the row when found", async () => {
    mockSelect.mockReturnValue(
      chain([{ id: "tea-1", authorId: "u1", title: null, content: "hi", pin: "1234" }]),
    );
    const row = await getTeaEntryById("tea-1");
    expect(row?.id).toBe("tea-1");
    expect(row?.pin).toBe("1234");
  });
});

describe("listTeaEntriesForAuthor", () => {
  it("returns summaries with a content excerpt (no full content, no pin)", async () => {
    mockSelect.mockReturnValue(
      chain([
        {
          id: "tea-1",
          authorId: "u1",
          title: "T",
          contentExcerpt: "first 500 chars of content",
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ]),
    );
    const out = await listTeaEntriesForAuthor("u1");
    expect(out).toHaveLength(1);
    expect(out[0].contentExcerpt).toBe("first 500 chars of content");
    const projection = mockSelect.mock.calls[0][0];
    expect(projection).toHaveProperty("id");
    expect(projection).toHaveProperty("title");
    expect(projection).toHaveProperty("contentExcerpt");
    // The author is the caller so leaking the prefix is fine, but we still
    // never project the raw `content` column (DB-side substring keeps the
    // wire payload bounded) or the `pin`.
    expect(projection).not.toHaveProperty("content");
    expect(projection).not.toHaveProperty("pin");
  });
});

describe("updateTeaEntry", () => {
  function updateChain(returnRows: unknown[]) {
    const where = vi.fn(() => ({ returning: vi.fn(() => Promise.resolve(returnRows)) }));
    const set = vi.fn(() => ({ where }));
    return { set, where };
  }

  it("only sets fields that were provided in the patch", async () => {
    const chain = updateChain([{ id: "tea-1", authorId: "u1", title: "new", content: "old", pin: "1234" }]);
    mockUpdate.mockReturnValue(chain);
    await updateTeaEntry("tea-1", "u1", { title: "new" });
    const setArg = chain.set.mock.calls[0][0] as Record<string, unknown>;
    expect(setArg).toHaveProperty("title", "new");
    expect(setArg).toHaveProperty("updatedAt");
    expect(setArg).not.toHaveProperty("content");
    expect(setArg).not.toHaveProperty("pin");
  });

  it("allows setting title to null explicitly", async () => {
    const chain = updateChain([{ id: "tea-1", authorId: "u1", title: null, content: "x", pin: "1234" }]);
    mockUpdate.mockReturnValue(chain);
    await updateTeaEntry("tea-1", "u1", { title: null });
    const setArg = chain.set.mock.calls[0][0] as Record<string, unknown>;
    expect(setArg).toHaveProperty("title", null);
  });

  it("returns the row when update succeeds (author matched)", async () => {
    const chain = updateChain([
      { id: "tea-1", authorId: "u1", title: "T", content: "C", pin: "9999", createdAt: new Date(), updatedAt: new Date() },
    ]);
    mockUpdate.mockReturnValue(chain);
    const row = await updateTeaEntry("tea-1", "u1", { content: "C", pin: "9999" });
    expect(row?.id).toBe("tea-1");
    expect(row?.pin).toBe("9999");
  });

  it("returns null when no row matched (missing or not author)", async () => {
    const chain = updateChain([]);
    mockUpdate.mockReturnValue(chain);
    expect(await updateTeaEntry("tea-1", "u-other", { content: "x" })).toBeNull();
  });
});

describe("deleteTeaEntry", () => {
  it("returns true when a row was deleted (caller is author)", async () => {
    const deleteChain = {
      where: vi.fn(() => ({
        returning: vi.fn(() => Promise.resolve([{ id: "tea-1" }])),
      })),
    };
    mockDelete.mockReturnValue(deleteChain);
    expect(await deleteTeaEntry("tea-1", "u1")).toBe(true);
  });
  it("returns false when no row matched", async () => {
    const deleteChain = {
      where: vi.fn(() => ({
        returning: vi.fn(() => Promise.resolve([])),
      })),
    };
    mockDelete.mockReturnValue(deleteChain);
    expect(await deleteTeaEntry("tea-1", "u1")).toBe(false);
  });
});
