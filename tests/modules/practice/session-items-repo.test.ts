import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockSelect, mockUpdate } = vi.hoisted(() => ({ mockSelect: vi.fn(), mockUpdate: vi.fn() }));

vi.mock("@/db/client", () => ({ db: { select: mockSelect, update: mockUpdate } }));
vi.mock("@/db/schema", () => ({
  practiceSessionItems: { itemId: {}, sessionId: {}, locationId: {}, setsCompleted: {}, completedAt: {} },
  practiceSessions: { id: {}, userId: {} },
  practiceLocations: { id: {}, userId: {} },
  vocabWords: { id: {}, word: {}, source: {} },
  practicePrescriptions: { itemId: {}, setMode: {}, setSize: {}, restSeconds: {} },
}));
vi.mock("drizzle-orm", () => ({
  and: vi.fn((...args: unknown[]) => ({ and: args })),
  asc: vi.fn((c: unknown) => ({ c, dir: "asc" })),
  eq: vi.fn((c: unknown, v: unknown) => ({ c, v })),
  inArray: vi.fn((c: unknown, v: unknown) => ({ c, v, op: "inArray" })),
  sql: Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }),
    { raw: (s: string) => ({ raw: s }) },
  ),
}));

function chain(rows: unknown[]) {
  const c: Record<string, unknown> = {};
  const p = Promise.resolve(rows);
  for (const m of ["from", "where", "orderBy", "limit", "innerJoin", "leftJoin", "groupBy"]) c[m] = vi.fn(() => c);
  Object.assign(c, { then: (r: any, j: any) => p.then(r, j) });
  return c;
}

import { listItemRowsForProgressByItems, syncSessionItem } from "@/modules/practice/session-items-repo";

beforeEach(() => vi.clearAllMocks());

describe("listItemRowsForProgressByItems", () => {
  it("returns an empty map without querying when itemIds is empty", async () => {
    const map = await listItemRowsForProgressByItems("user-1", []);
    expect(map.size).toBe(0);
    expect(mockSelect).not.toHaveBeenCalled();
  });

  it("groups rows by itemId in a single query", async () => {
    mockSelect.mockReturnValueOnce(
      chain([
        { itemId: "item-a", locationId: "loc-1", setsCompleted: 5, completedAt: null },
        { itemId: "item-b", locationId: "loc-2", setsCompleted: 3, completedAt: null },
        { itemId: "item-a", locationId: "loc-3", setsCompleted: 6, completedAt: null },
      ]),
    );

    const map = await listItemRowsForProgressByItems("user-1", ["item-a", "item-b", "item-c"]);

    // one batched query, not one per item
    expect(mockSelect).toHaveBeenCalledTimes(1);
    expect(map.get("item-a")).toHaveLength(2);
    expect(map.get("item-b")).toHaveLength(1);
    // item with no rows is absent (callers treat missing as empty)
    expect(map.has("item-c")).toBe(false);
    expect(map.get("item-a")!.map((r) => r.locationId)).toEqual(["loc-1", "loc-3"]);
  });

  it("returns an empty map when the query yields no rows", async () => {
    mockSelect.mockReturnValueOnce(chain([]));
    const map = await listItemRowsForProgressByItems("user-1", ["item-a"]);
    expect(mockSelect).toHaveBeenCalledTimes(1);
    expect(map.size).toBe(0);
  });
});

describe("syncSessionItem locationId (SHAN-735)", () => {
  function updateChain() {
    const set = vi.fn(() => ({ where: vi.fn(() => Promise.resolve()) }));
    mockUpdate.mockReturnValueOnce({ set });
    return set;
  }

  it("rejects a location that is not the caller's, without writing", async () => {
    mockSelect
      .mockReturnValueOnce(chain([{ id: "si1" }])) // item ownership
      .mockReturnValueOnce(chain([])); // location lookup: not this user's
    const result = await syncSessionItem("si1", "user-1", { locationId: "loc-other", setsCompleted: 2 });
    expect(result).toBe("unknown_location");
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("writes a location the caller owns", async () => {
    mockSelect
      .mockReturnValueOnce(chain([{ id: "si1" }]))
      .mockReturnValueOnce(chain([{ id: "loc-1" }]))
      .mockReturnValueOnce(chain([{ id: "si1", locationId: "loc-1", setsCompleted: 0 }]));
    const set = updateChain();
    const result = await syncSessionItem("si1", "user-1", { locationId: "loc-1" });
    expect(set).toHaveBeenCalledWith({ locationId: "loc-1" });
    expect(result).toMatchObject({ id: "si1", locationId: "loc-1" });
  });

  it("clears the location on null without a lookup", async () => {
    mockSelect
      .mockReturnValueOnce(chain([{ id: "si1" }]))
      .mockReturnValueOnce(chain([{ id: "si1", locationId: null }]));
    const set = updateChain();
    await syncSessionItem("si1", "user-1", { locationId: null });
    expect(mockSelect).toHaveBeenCalledTimes(2);
    expect(set).toHaveBeenCalledWith({ locationId: null });
  });

  it("returns null for someone else's item before checking the location", async () => {
    mockSelect.mockReturnValueOnce(chain([]));
    const result = await syncSessionItem("si1", "user-2", { locationId: "loc-1" });
    expect(result).toBeNull();
    expect(mockSelect).toHaveBeenCalledTimes(1);
  });
});
