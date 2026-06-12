import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockSelect, mockInsert, mockDelete } = vi.hoisted(() => ({
  mockSelect: vi.fn(),
  mockInsert: vi.fn(),
  mockDelete: vi.fn(),
}));

vi.mock("@/db/client", () => ({
  db: { select: mockSelect, insert: mockInsert, delete: mockDelete },
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
  it("returns summaries (no content / no pin in projection)", async () => {
    mockSelect.mockReturnValue(
      chain([
        { id: "tea-1", authorId: "u1", title: "T", createdAt: new Date(), updatedAt: new Date() },
      ]),
    );
    const out = await listTeaEntriesForAuthor("u1");
    expect(out).toHaveLength(1);
    const projection = mockSelect.mock.calls[0][0];
    expect(projection).toHaveProperty("id");
    expect(projection).toHaveProperty("title");
    expect(projection).not.toHaveProperty("content");
    expect(projection).not.toHaveProperty("pin");
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
