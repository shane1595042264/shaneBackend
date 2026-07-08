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
  for (const m of ["from", "where", "orderBy", "limit"]) c[m] = vi.fn(() => c);
  Object.assign(c, { then: (r: any, j: any) => t.then(r, j) });
  return c;
}

import {
  createSkincareProduct,
  deleteSkincareProduct,
  listSkincareProducts,
  reorderSkincareProducts,
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
  // Each loop iteration runs a fresh update().set().where().returning().
  function updateReturning(rows: unknown[]) {
    return {
      set: vi.fn(() => ({
        where: vi.fn(() => ({ returning: vi.fn(() => Promise.resolve(rows)) })),
      })),
    };
  }

  it("sets each id's position to its index and returns the moved count", async () => {
    // Two ids, both belong to the caller → each update returns one row.
    mockUpdate
      .mockReturnValueOnce(updateReturning([{ id: "a" }]))
      .mockReturnValueOnce(updateReturning([{ id: "b" }]));
    const moved = await reorderSkincareProducts("u1", "morning", ["a", "b"]);
    expect(moved).toBe(2);
    expect(mockUpdate).toHaveBeenCalledTimes(2);
  });

  it("counts only rows that matched (foreign/stale id moves nothing)", async () => {
    mockUpdate
      .mockReturnValueOnce(updateReturning([{ id: "a" }]))
      .mockReturnValueOnce(updateReturning([])); // second id not the caller's
    const moved = await reorderSkincareProducts("u1", "morning", ["a", "foreign"]);
    expect(moved).toBe(1);
  });
});
