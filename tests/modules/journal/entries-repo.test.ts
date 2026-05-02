import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockSelect, mockInsert, mockUpdate, mockTransaction } = vi.hoisted(() => ({
  mockSelect: vi.fn(),
  mockInsert: vi.fn(),
  mockUpdate: vi.fn(),
  mockTransaction: vi.fn(),
}));

vi.mock("@/db/client", () => ({
  db: { select: mockSelect, insert: mockInsert, update: mockUpdate, transaction: mockTransaction },
}));
vi.mock("@/db/schema", () => ({
  journalEntries: {},
  journalVersions: {},
}));
vi.mock("drizzle-orm", () => ({
  eq: vi.fn((c: unknown, v: unknown) => ({ c, v })),
  and: vi.fn((...args: unknown[]) => ({ and: args })),
  desc: vi.fn((c: unknown) => ({ c, dir: "desc" })),
  lt: vi.fn((c: unknown, v: unknown) => ({ c, v, op: "lt" })),
  gte: vi.fn((c: unknown, v: unknown) => ({ c, v, op: "gte" })),
  lte: vi.fn((c: unknown, v: unknown) => ({ c, v, op: "lte" })),
  sql: vi.fn(),
}));

function chain(rows: unknown[]) {
  const c: Record<string, unknown> = {};
  const t = Promise.resolve(rows);
  for (const m of ["from", "where", "orderBy", "limit", "leftJoin", "innerJoin"]) c[m] = vi.fn(() => c);
  Object.assign(c, { then: (r: any, j: any) => t.then(r, j) });
  return c;
}

import { createEntry, getEntryByDate, listEntries, softDeleteEntry, hashContent } from "@/modules/journal/entries-repo";

beforeEach(() => vi.clearAllMocks());

describe("hashContent", () => {
  it("produces a stable 64-char sha256 hex digest", () => {
    expect(hashContent("hello")).toHaveLength(64);
    expect(hashContent("hello")).toBe(hashContent("hello"));
    expect(hashContent("hello")).not.toBe(hashContent("world"));
  });
});

describe("createEntry", () => {
  it("inserts entry + initial version + sets currentVersionId in a single transaction", async () => {
    const txCalls: string[] = [];
    const tx = {
      insert: vi.fn(() => {
        txCalls.push("insert");
        return {
          values: vi.fn(() => ({
            returning: vi.fn(() => {
              const callIdx = txCalls.length;
              return Promise.resolve(
                callIdx === 1
                  ? [{ id: "entry-1", date: "2026-04-29", authorId: "user-1" }]
                  : [{ id: "version-1", entryId: "entry-1", versionNum: 1, content: "hello" }]
              );
            }),
          })),
        };
      }),
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn(() => Promise.resolve()),
        })),
      })),
    };
    mockTransaction.mockImplementation(async (fn: any) => fn(tx));

    const result = await createEntry({ date: "2026-04-29", authorId: "user-1", content: "hello" });
    expect(result.entry.id).toBe("entry-1");
    expect(result.entry.currentVersionId).toBe("version-1");
    expect(result.version.versionNum).toBe(1);
    expect(tx.insert).toHaveBeenCalledTimes(2);
    expect(tx.update).toHaveBeenCalledTimes(1);
  });
});

describe("getEntryByDate", () => {
  it("returns null when no entry exists", async () => {
    mockSelect.mockReturnValue(chain([]));
    expect(await getEntryByDate("2026-04-29")).toBeNull();
  });

  it("returns entry+currentVersion when found", async () => {
    mockSelect.mockReturnValue(chain([{ entry: { id: "e1", date: "2026-04-29" }, currentVersion: { versionNum: 1, content: "hi" } }]));
    const out = await getEntryByDate("2026-04-29");
    expect(out?.entry.id).toBe("e1");
    expect(out?.currentVersion?.content).toBe("hi");
  });
});

describe("listEntries", () => {
  it("applies cursor-date and limit", async () => {
    mockSelect.mockReturnValue(chain([{ id: "e1", date: "2026-04-28" }]));
    const out = await listEntries({ limit: 10, cursorDate: "2026-04-29" });
    expect(out).toEqual([{ id: "e1", date: "2026-04-28" }]);
  });

  it("applies from/to date range", async () => {
    mockSelect.mockReturnValue(chain([{ id: "e1", date: "2026-04-15" }]));
    const out = await listEntries({ limit: 10, from: "2026-04-01", to: "2026-04-30" });
    expect(out).toHaveLength(1);
  });
});

describe("softDeleteEntry", () => {
  it("returns true when a row was updated (caller is author)", async () => {
    const updateChain = {
      set: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: vi.fn(() => Promise.resolve([{ id: "e1" }])),
        })),
      })),
    };
    mockUpdate.mockReturnValue(updateChain);
    expect(await softDeleteEntry("2026-04-29", "user-1")).toBe(true);
  });

  it("returns false when no row matched (caller not author or entry missing)", async () => {
    const updateChain = {
      set: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: vi.fn(() => Promise.resolve([])),
        })),
      })),
    };
    mockUpdate.mockReturnValue(updateChain);
    expect(await softDeleteEntry("2026-04-29", "user-1")).toBe(false);
  });
});
