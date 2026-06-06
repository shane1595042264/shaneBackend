import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockSelect } = vi.hoisted(() => ({ mockSelect: vi.fn() }));

vi.mock("@/db/client", () => ({ db: { select: mockSelect } }));
vi.mock("@/db/schema", () => ({
  vocabWords: { id: {}, word: {}, category: {}, source: {} },
  practicePrescriptions: { itemId: {}, setMode: {}, setSize: {}, restSeconds: {} },
  practiceSessionItems: { id: {}, sessionId: {}, itemId: {}, locationId: {}, locationName: {}, completedAt: {} },
  practiceSessions: { id: {}, userId: {} },
}));
vi.mock("drizzle-orm", () => ({
  and: vi.fn((...args: unknown[]) => ({ and: args })),
  desc: vi.fn((c: unknown) => ({ c, dir: "desc" })),
  eq: vi.fn((c: unknown, v: unknown) => ({ c, v })),
  isNotNull: vi.fn((c: unknown) => ({ c, op: "isNotNull" })),
  sql: Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }),
    { raw: (s: string) => ({ raw: s }) },
  ),
}));
vi.mock("@/modules/practice/settings-repo", () => ({
  getSettings: vi.fn(async () => ({
    setsPerStrike: 5,
    strikesPerLoadedLocation: 5,
    locationsToSolidify: 7,
    updatedAt: new Date(0),
    updatedBy: null,
  })),
}));
vi.mock("@/modules/practice/session-items-repo", () => ({
  listItemRowsForProgress: vi.fn(async () => []),
}));
vi.mock("@/modules/practice/strikes", () => ({
  computeProgress: vi.fn(() => ({
    totalStrikes: 0,
    isSolidified: false,
    loadedLocations: [],
    strikeCountsByLocation: new Map(),
  })),
}));

function chain(rows: unknown[]) {
  const c: Record<string, unknown> = {};
  const p = Promise.resolve(rows);
  for (const m of ["from", "where", "orderBy", "limit", "innerJoin", "leftJoin", "groupBy"]) c[m] = vi.fn(() => c);
  Object.assign(c, { then: (r: any, j: any) => p.then(r, j) });
  return c;
}

import { getItemProgressDetail, listPracticeableItems } from "@/modules/practice/items-repo";

const ITEM = {
  itemId: "item-1",
  word: "deadlift",
  setMode: "reps",
  setSize: 5,
  restSeconds: 90,
};

beforeEach(() => vi.clearAllMocks());

describe("getItemProgressDetail lastPracticedAt", () => {
  it("returns ISO string of latest completedAt when sessions exist", async () => {
    const latestDate = new Date("2026-05-20T14:30:00Z");
    mockSelect
      .mockReturnValueOnce(chain([ITEM])) // item lookup
      .mockReturnValueOnce(chain([])) // locNames lookup
      .mockReturnValueOnce(chain([{ completedAt: latestDate }])); // latest lookup

    const detail = await getItemProgressDetail("user-1", "item-1");
    expect(detail?.lastPracticedAt).toBe("2026-05-20T14:30:00.000Z");
  });

  it("returns null when item has never been practiced (no completed rows)", async () => {
    mockSelect
      .mockReturnValueOnce(chain([ITEM]))
      .mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(chain([])); // no latest row

    const detail = await getItemProgressDetail("user-1", "item-1");
    expect(detail?.lastPracticedAt).toBeNull();
  });

  it("returns null when item not found", async () => {
    mockSelect.mockReturnValueOnce(chain([])); // item lookup empty
    const detail = await getItemProgressDetail("user-1", "item-1");
    expect(detail).toBeNull();
  });

  it("coerces string-shaped timestamp from DB into ISO string passthrough", async () => {
    mockSelect
      .mockReturnValueOnce(chain([ITEM]))
      .mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(chain([{ completedAt: "2026-05-21T10:00:00.000Z" }]));

    const detail = await getItemProgressDetail("user-1", "item-1");
    expect(detail?.lastPracticedAt).toBe("2026-05-21T10:00:00.000Z");
  });
});

const LIST_ITEM_A = {
  itemId: "item-a",
  word: "squat",
  category: "exercise",
  source: null,
  setMode: "reps",
  setSize: 5,
  restSeconds: 90,
};
const LIST_ITEM_B = {
  itemId: "item-b",
  word: "deadlift",
  category: "exercise",
  source: null,
  setMode: "reps",
  setSize: 3,
  restSeconds: 120,
};

describe("listPracticeableItems lastPracticedAt", () => {
  it("populates lastPracticedAt per item from the GROUP BY map (null sorts first)", async () => {
    const latestDate = new Date("2026-05-20T14:30:00Z");
    mockSelect
      .mockReturnValueOnce(chain([LIST_ITEM_A, LIST_ITEM_B])) // items list
      .mockReturnValueOnce(chain([{ itemId: "item-a", lastCompletedAt: latestDate }])); // GROUP BY

    const items = await listPracticeableItems({
      userId: "user-1",
      categoryFilter: null,
      includeSolidified: true,
    });

    expect(items).toHaveLength(2);
    // item-b (null lastPracticedAt) sorts ahead of item-a (has a date)
    expect(items[0].itemId).toBe("item-b");
    expect(items[0].lastPracticedAt).toBeNull();
    expect(items[1].itemId).toBe("item-a");
    expect(items[1].lastPracticedAt).toBe("2026-05-20T14:30:00.000Z");
  });

  it("returns lastPracticedAt null for every item when nobody has practiced anything", async () => {
    mockSelect
      .mockReturnValueOnce(chain([LIST_ITEM_A]))
      .mockReturnValueOnce(chain([])); // empty GROUP BY

    const items = await listPracticeableItems({
      userId: "user-1",
      categoryFilter: null,
      includeSolidified: true,
    });

    expect(items[0].lastPracticedAt).toBeNull();
  });

  it("coerces string-shaped lastCompletedAt from DB into ISO passthrough", async () => {
    mockSelect
      .mockReturnValueOnce(chain([LIST_ITEM_A]))
      .mockReturnValueOnce(chain([{ itemId: "item-a", lastCompletedAt: "2026-05-21T10:00:00.000Z" }]));

    const items = await listPracticeableItems({
      userId: "user-1",
      categoryFilter: null,
      includeSolidified: true,
    });

    expect(items[0].lastPracticedAt).toBe("2026-05-21T10:00:00.000Z");
  });
});

describe("listPracticeableItems triage sort order", () => {
  const NEVER = {
    itemId: "item-never",
    word: "alpha",
    category: "exercise",
    source: null,
    setMode: "reps",
    setSize: 5,
    restSeconds: 90,
  };
  const COLD = {
    itemId: "item-cold",
    word: "bravo",
    category: "exercise",
    source: null,
    setMode: "reps",
    setSize: 5,
    restSeconds: 90,
  };
  const WARM = {
    itemId: "item-warm",
    word: "charlie",
    category: "exercise",
    source: null,
    setMode: "reps",
    setSize: 5,
    restSeconds: 90,
  };

  it("orders items null-first, then by lastPracticedAt asc (coldest before warmest)", async () => {
    // DB returns them in arbitrary order — warm, never, cold — to prove the sort runs.
    mockSelect
      .mockReturnValueOnce(chain([WARM, NEVER, COLD]))
      .mockReturnValueOnce(chain([
        { itemId: "item-warm", lastCompletedAt: "2026-06-01T00:00:00.000Z" },
        { itemId: "item-cold", lastCompletedAt: "2025-01-01T00:00:00.000Z" },
      ]));

    const items = await listPracticeableItems({
      userId: "user-1",
      categoryFilter: null,
      includeSolidified: true,
    });

    expect(items.map((i) => i.itemId)).toEqual(["item-never", "item-cold", "item-warm"]);
  });

  it("breaks ties between two never-practiced items by word ascending", async () => {
    const NEVER_Z = { ...NEVER, itemId: "item-zulu", word: "zulu" };
    mockSelect
      .mockReturnValueOnce(chain([NEVER_Z, NEVER])) // zulu fed first to prove sort flips it
      .mockReturnValueOnce(chain([])); // no completions

    const items = await listPracticeableItems({
      userId: "user-1",
      categoryFilter: null,
      includeSolidified: true,
    });

    expect(items.map((i) => i.word)).toEqual(["alpha", "zulu"]);
  });
});
