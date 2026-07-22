import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockSelect } = vi.hoisted(() => ({ mockSelect: vi.fn() }));

vi.mock("@/db/client", () => ({ db: { select: mockSelect } }));
vi.mock("@/db/schema", () => ({
  practiceSessionItems: { itemId: {}, sessionId: {}, locationId: {}, setsCompleted: {}, completedAt: {} },
  practiceSessions: { id: {}, userId: {} },
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

import { listItemRowsForProgressByItems } from "@/modules/practice/session-items-repo";

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
