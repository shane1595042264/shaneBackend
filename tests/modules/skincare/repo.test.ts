import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockSelect, mockInsert, mockDelete, mockUpdate, mockTransaction } = vi.hoisted(() => ({
  mockSelect: vi.fn(),
  mockInsert: vi.fn(),
  mockDelete: vi.fn(),
  mockUpdate: vi.fn(),
  mockTransaction: vi.fn(),
}));

vi.mock("@/db/client", () => ({
  db: {
    select: mockSelect,
    insert: mockInsert,
    delete: mockDelete,
    update: mockUpdate,
    transaction: mockTransaction,
  },
}));
vi.mock("@/db/schema", () => ({
  skincareProducts: {
    id: {},
    userId: {},
    timeOfDay: {},
    name: {},
    brand: {},
    imageUrl: {},
    position: {},
    startedAt: {},
    createdAt: {},
    updatedAt: {},
  },
}));
vi.mock("drizzle-orm", () => ({
  eq: vi.fn((c: unknown, v: unknown) => ({ eq: [c, v] })),
  and: vi.fn((...args: unknown[]) => ({ and: args })),
  asc: vi.fn((c: unknown) => ({ c, dir: "asc" })),
  sql: Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => ({ kind: "sql", strings, values }),
    { raw: (s: string) => ({ kind: "sql-raw", s }) },
  ),
}));

function chain(rows: unknown[]) {
  const c: Record<string, unknown> = {};
  const t = Promise.resolve(rows);
  for (const m of ["from", "where", "orderBy", "limit", "for"]) c[m] = vi.fn(() => c);
  Object.assign(c, { then: (r: any, j: any) => t.then(r, j) });
  return c;
}

import {
  createSkincareProduct,
  deleteSkincareProduct,
  listSkincareProducts,
  reorderSkincareProducts,
  SkincareReorderMismatchError,
  updateSkincareProduct,
} from "@/modules/skincare/repo";

beforeEach(() => vi.clearAllMocks());

describe("listSkincareProducts", () => {
  it("selects the caller's rows ordered by (timeOfDay, position)", async () => {
    const c = chain([
      { id: "p1", userId: "u1", timeOfDay: "morning", name: "Cleanser", position: 0 },
    ]);
    mockSelect.mockReturnValue(c);
    const out = await listSkincareProducts("u1");
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("p1");
    // two orderBy args → timeOfDay then position
    expect((c.orderBy as ReturnType<typeof vi.fn>).mock.calls[0]).toHaveLength(2);
  });
});

describe("createSkincareProduct", () => {
  it("inserts with a computed next position and nulls for missing optionals", async () => {
    const insertChain = {
      values: vi.fn(() => ({
        returning: vi.fn(() =>
          Promise.resolve([
            {
              id: "p1",
              userId: "u1",
              timeOfDay: "night",
              name: "Serum",
              brand: null,
              imageUrl: null,
              position: 0,
              startedAt: new Date(),
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          ]),
        ),
      })),
    };
    mockInsert.mockReturnValue(insertChain);
    const out = await createSkincareProduct({ userId: "u1", timeOfDay: "night", name: "Serum" });
    expect(out.id).toBe("p1");
    const values = insertChain.values.mock.calls[0][0] as Record<string, unknown>;
    expect(values).toMatchObject({
      userId: "u1",
      timeOfDay: "night",
      name: "Serum",
      brand: null,
      imageUrl: null,
    });
    // position is a computed SQL expression, not a literal number
    expect((values.position as { kind?: string })?.kind).toBe("sql");
  });
});

describe("updateSkincareProduct", () => {
  function updateChain(returnRows: unknown[]) {
    const where = vi.fn(() => ({ returning: vi.fn(() => Promise.resolve(returnRows)) }));
    const set = vi.fn(() => ({ where }));
    return { set, where };
  }

  it("only sets provided fields (+ updatedAt), never untouched ones", async () => {
    const ch = updateChain([{ id: "p1", userId: "u1", name: "New", timeOfDay: "morning" }]);
    mockUpdate.mockReturnValue(ch);
    await updateSkincareProduct("p1", "u1", { name: "New" });
    const setArg = ch.set.mock.calls[0][0] as Record<string, unknown>;
    expect(setArg).toHaveProperty("name", "New");
    expect(setArg).toHaveProperty("updatedAt");
    expect(setArg).not.toHaveProperty("brand");
    expect(setArg).not.toHaveProperty("timeOfDay");
    expect(setArg).not.toHaveProperty("position");
  });

  it("allows clearing brand/imageUrl to null explicitly", async () => {
    const ch = updateChain([{ id: "p1", userId: "u1", brand: null, imageUrl: null }]);
    mockUpdate.mockReturnValue(ch);
    await updateSkincareProduct("p1", "u1", { brand: null, imageUrl: null });
    const setArg = ch.set.mock.calls[0][0] as Record<string, unknown>;
    expect(setArg).toHaveProperty("brand", null);
    expect(setArg).toHaveProperty("imageUrl", null);
  });

  it("moving to the other routine recomputes position as a SQL expression", async () => {
    const ch = updateChain([{ id: "p1", userId: "u1", timeOfDay: "night" }]);
    mockUpdate.mockReturnValue(ch);
    await updateSkincareProduct("p1", "u1", { timeOfDay: "night" });
    const setArg = ch.set.mock.calls[0][0] as Record<string, unknown>;
    expect(setArg).toHaveProperty("timeOfDay", "night");
    expect((setArg.position as { kind?: string })?.kind).toBe("sql");
  });

  it("returns null when no row matched (missing or not owner)", async () => {
    const ch = updateChain([]);
    mockUpdate.mockReturnValue(ch);
    expect(await updateSkincareProduct("p1", "u-other", { name: "x" })).toBeNull();
  });
});

describe("deleteSkincareProduct", () => {
  it("returns true when a row was deleted", async () => {
    mockDelete.mockReturnValue({
      where: vi.fn(() => ({ returning: vi.fn(() => Promise.resolve([{ id: "p1" }])) })),
    });
    expect(await deleteSkincareProduct("p1", "u1")).toBe(true);
  });
  it("returns false when nothing matched", async () => {
    mockDelete.mockReturnValue({
      where: vi.fn(() => ({ returning: vi.fn(() => Promise.resolve([])) })),
    });
    expect(await deleteSkincareProduct("p1", "u1")).toBe(false);
  });
});

describe("reorderSkincareProducts", () => {
  // The reorder runs inside db.transaction; the tx reuses the db mocks so
  // the routine read and the per-id updates can be asserted directly.
  beforeEach(() => {
    mockTransaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
      fn({ select: mockSelect, update: mockUpdate }),
    );
  });

  function updateWhere() {
    const where = vi.fn(() => Promise.resolve(undefined));
    return { set: vi.fn(() => ({ where })) };
  }

  it("sets each id's position to its index when the ids are exactly the routine", async () => {
    const routine = chain([{ id: "a" }, { id: "b" }]);
    mockSelect.mockReturnValue(routine);
    const u1 = updateWhere();
    const u2 = updateWhere();
    mockUpdate.mockReturnValueOnce(u1).mockReturnValueOnce(u2);
    const moved = await reorderSkincareProducts("u1", "morning", ["b", "a"]);
    expect(moved).toBe(2);
    expect(routine.for).toHaveBeenCalledWith("update");
    expect(u1.set).toHaveBeenCalledWith(expect.objectContaining({ position: 0 }));
    expect(u2.set).toHaveBeenCalledWith(expect.objectContaining({ position: 1 }));
  });

  it("throws before any write when an id is stale or foreign (SHAN-580)", async () => {
    mockSelect.mockReturnValue(chain([{ id: "a" }, { id: "b" }, { id: "c" }]));
    await expect(
      reorderSkincareProducts("u1", "morning", ["c", "a", "foreign"]),
    ).rejects.toBeInstanceOf(SkincareReorderMismatchError);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("throws on a subset of the routine instead of leaving the rest on duplicate positions", async () => {
    mockSelect.mockReturnValue(chain([{ id: "a" }, { id: "b" }, { id: "c" }]));
    await expect(
      reorderSkincareProducts("u1", "morning", ["c", "a"]),
    ).rejects.toBeInstanceOf(SkincareReorderMismatchError);
    expect(mockUpdate).not.toHaveBeenCalled();
  });
});
