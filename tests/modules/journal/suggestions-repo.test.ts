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
  journalSuggestions: {},
}));
vi.mock("drizzle-orm", () => ({
  eq: vi.fn((c, v) => ({ c, v })),
  and: vi.fn((...a) => ({ and: a })),
  desc: vi.fn((c) => ({ c, dir: "desc" })),
  sql: vi.fn(() => ({ __sql: true })),
}));

function chain(rows: unknown[]) {
  const c: Record<string, unknown> = {};
  const t = Promise.resolve(rows);
  for (const m of ["from", "where", "orderBy", "limit", "leftJoin", "innerJoin"]) c[m] = vi.fn(() => c);
  Object.assign(c, { then: (r: any, j: any) => t.then(r, j) });
  return c;
}

import {
  createSuggestion,
  getSuggestion,
  listSuggestionsForEntry,
  inboxFor,
  approveSuggestion,
  rejectSuggestion,
  withdrawSuggestion,
} from "@/modules/journal/suggestions-repo";

beforeEach(() => vi.clearAllMocks());

describe("createSuggestion", () => {
  it("inserts suggestion and increments pendingSuggestionCount on the entry", async () => {
    const tx = {
      insert: vi.fn(() => ({
        values: vi.fn(() => ({
          returning: vi.fn(() => Promise.resolve([{ id: "s1", status: "pending" }])),
        })),
      })),
      update: vi.fn(() => ({
        set: vi.fn(() => ({ where: vi.fn(() => Promise.resolve()) })),
      })),
    };
    mockTransaction.mockImplementation(async (fn: any) => fn(tx));

    const out = await createSuggestion({ entryId: "e1", proposerId: "u2", baseVersionId: "v1", proposedContent: "edit" });
    expect(out.id).toBe("s1");
    expect(tx.insert).toHaveBeenCalledTimes(1);
    expect(tx.update).toHaveBeenCalledTimes(1);
  });
});

describe("getSuggestion", () => {
  it("returns null when not found", async () => {
    mockSelect.mockReturnValue(chain([]));
    expect(await getSuggestion("missing")).toBeNull();
  });

  it("returns the suggestion when found", async () => {
    mockSelect.mockReturnValue(chain([{ id: "s1", entryId: "e1", proposerId: "u2", status: "pending" }]));
    const s = await getSuggestion("s1");
    expect(s?.id).toBe("s1");
  });
});

describe("listSuggestionsForEntry", () => {
  it("filters by status when supplied", async () => {
    mockSelect.mockReturnValue(chain([{ id: "s1", status: "pending" }]));
    const out = await listSuggestionsForEntry("e1", "pending");
    expect(out).toHaveLength(1);
  });

  it("returns all when no status filter", async () => {
    mockSelect.mockReturnValue(chain([{ id: "s1" }, { id: "s2" }]));
    const out = await listSuggestionsForEntry("e1");
    expect(out).toHaveLength(2);
  });
});

describe("inboxFor", () => {
  it("returns pending suggestions on entries the user authored", async () => {
    mockSelect.mockReturnValue(chain([
      { suggestion: { id: "s1", status: "pending" }, entry: { id: "e1", date: "2026-05-03", authorId: "u1" } },
    ]));
    const out = await inboxFor("u1");
    expect(out).toHaveLength(1);
    expect(out[0].suggestion.id).toBe("s1");
  });
});

describe("approveSuggestion", () => {
  it("creates new version and marks suggestion approved when If-Match matches", async () => {
    let captured: any = null;
    let selectCall = 0;
    const tx = {
      select: vi.fn(() => {
        selectCall++;
        if (selectCall === 1) {
          return chain([{ id: "s1", entryId: "e1", proposerId: "u2", proposedContent: "merged content", status: "pending" }]);
        }
        return chain([{ id: "v1", versionNum: 1 }]);
      }) as any,
      insert: vi.fn(() => ({
        values: vi.fn((v: any) => { captured = v; return {
          returning: vi.fn(() => Promise.resolve([{ id: "v2", versionNum: 2 }])),
        };}),
      })),
      update: vi.fn(() => ({
        set: vi.fn(() => ({ where: vi.fn(() => Promise.resolve()) })),
      })),
    };
    mockTransaction.mockImplementation(async (fn: any) => fn(tx));

    const v = await approveSuggestion("s1", "u1", 1);
    expect(v.versionNum).toBe(2);
    expect(captured.source).toBe("suggestion");
    expect(captured.editorId).toBe("u2"); // suggester gets attribution
    expect(captured.suggestionId).toBe("s1");
    expect(tx.update).toHaveBeenCalledTimes(2); // entry + suggestion
  });

  it("throws when suggestion is not pending", async () => {
    const tx = {
      select: vi.fn(() => chain([{ id: "s1", status: "approved" }])),
    };
    mockTransaction.mockImplementation(async (fn: any) => fn(tx));
    await expect(approveSuggestion("s1", "u1", 1)).rejects.toThrow();
  });

  it("throws VersionConflictError when If-Match doesn't match current latest", async () => {
    let selectCall = 0;
    const tx = {
      select: vi.fn(() => {
        selectCall++;
        if (selectCall === 1) {
          return chain([{ id: "s1", entryId: "e1", proposerId: "u2", proposedContent: "x", status: "pending" }]);
        }
        return chain([{ id: "v5", versionNum: 5 }]);
      }) as any,
    };
    mockTransaction.mockImplementation(async (fn: any) => fn(tx));
    await expect(approveSuggestion("s1", "u1", 3)).rejects.toMatchObject({ name: "VersionConflict", currentVersionNum: 5 });
  });
});

describe("rejectSuggestion", () => {
  it("sets status=rejected and decrements pendingSuggestionCount", async () => {
    const tx = {
      select: vi.fn(() => chain([{ id: "s1", entryId: "e1", status: "pending" }])),
      update: vi.fn(() => ({
        set: vi.fn(() => ({ where: vi.fn(() => Promise.resolve()) })),
      })),
    };
    mockTransaction.mockImplementation(async (fn: any) => fn(tx));
    await rejectSuggestion("s1", "u1", "not for me");
    expect(tx.update).toHaveBeenCalledTimes(2);
  });
});

describe("withdrawSuggestion", () => {
  it("only the proposer can withdraw", async () => {
    const tx = {
      select: vi.fn(() => chain([])),
    };
    mockTransaction.mockImplementation(async (fn: any) => fn(tx));
    await expect(withdrawSuggestion("s1", "wrong-user")).rejects.toThrow();
  });

  it("sets status=withdrawn and decrements pendingSuggestionCount", async () => {
    const tx = {
      select: vi.fn(() => chain([{ id: "s1", entryId: "e1", proposerId: "u2", status: "pending" }])),
      update: vi.fn(() => ({
        set: vi.fn(() => ({ where: vi.fn(() => Promise.resolve()) })),
      })),
    };
    mockTransaction.mockImplementation(async (fn: any) => fn(tx));
    await withdrawSuggestion("s1", "u2");
    expect(tx.update).toHaveBeenCalledTimes(2);
  });
});
