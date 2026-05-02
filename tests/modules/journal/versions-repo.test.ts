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
vi.mock("@/db/schema", () => ({ journalEntries: {}, journalVersions: {} }));
vi.mock("drizzle-orm", () => ({
  eq: vi.fn((c: unknown, v: unknown) => ({ c, v })),
  and: vi.fn((...a: unknown[]) => ({ and: a })),
  desc: vi.fn((c: unknown) => ({ c, dir: "desc" })),
  sql: vi.fn(() => ({ __sql: true })),
}));

function chain(rows: unknown[]) {
  const c: Record<string, unknown> = {};
  const t = Promise.resolve(rows);
  for (const m of ["from", "where", "orderBy", "limit"]) c[m] = vi.fn(() => c);
  Object.assign(c, { then: (r: any, j: any) => t.then(r, j) });
  return c;
}

import {
  appendDirectVersion,
  listVersions,
  getVersion,
  revertToVersion,
  VersionConflictError,
} from "@/modules/journal/versions-repo";

beforeEach(() => vi.clearAllMocks());

describe("appendDirectVersion", () => {
  it("inserts new version with versionNum = current+1 and bumps the entry's currentVersionId + editCount", async () => {
    const tx = {
      select: vi.fn(() => chain([{ id: "v3", versionNum: 3 }])),
      insert: vi.fn(() => ({
        values: vi.fn(() => ({
          returning: vi.fn(() => Promise.resolve([{ id: "v4", versionNum: 4 }])),
        })),
      })),
      update: vi.fn(() => ({
        set: vi.fn(() => ({ where: vi.fn(() => Promise.resolve()) })),
      })),
    };
    mockTransaction.mockImplementation(async (fn: any) => fn(tx));

    const v = await appendDirectVersion({
      entryId: "e1",
      editorId: "u1",
      content: "new content",
      ifMatchVersionNum: 3,
    });

    expect(v.versionNum).toBe(4);
    expect(v.id).toBe("v4");
    expect(tx.insert).toHaveBeenCalledTimes(1);
    expect(tx.update).toHaveBeenCalledTimes(1);
  });

  it("throws VersionConflictError when If-Match doesn't match current", async () => {
    const tx = {
      select: vi.fn(() => chain([{ id: "v5", versionNum: 5 }])),
    };
    mockTransaction.mockImplementation(async (fn: any) => fn(tx));

    await expect(
      appendDirectVersion({ entryId: "e1", editorId: "u1", content: "x", ifMatchVersionNum: 3 })
    ).rejects.toMatchObject({ name: "VersionConflict", currentVersionNum: 5 });
  });

  it("throws VersionConflictError when no versions exist for the entry", async () => {
    const tx = {
      select: vi.fn(() => chain([])),
    };
    mockTransaction.mockImplementation(async (fn: any) => fn(tx));

    await expect(
      appendDirectVersion({ entryId: "e1", editorId: "u1", content: "x", ifMatchVersionNum: 1 })
    ).rejects.toBeInstanceOf(VersionConflictError);
  });

  it("supports source='suggestion' with suggestion_id", async () => {
    let capturedValues: any = null;
    const tx = {
      select: vi.fn(() => chain([{ id: "v1", versionNum: 1 }])),
      insert: vi.fn(() => ({
        values: vi.fn((v: unknown) => { capturedValues = v; return {
          returning: vi.fn(() => Promise.resolve([{ id: "v2", versionNum: 2 }])),
        };}),
      })),
      update: vi.fn(() => ({
        set: vi.fn(() => ({ where: vi.fn(() => Promise.resolve()) })),
      })),
    };
    mockTransaction.mockImplementation(async (fn: any) => fn(tx));

    await appendDirectVersion({
      entryId: "e1",
      editorId: "u2",
      content: "merged",
      ifMatchVersionNum: 1,
      source: "suggestion",
      suggestionId: "s1",
    });
    expect(capturedValues.source).toBe("suggestion");
    expect(capturedValues.suggestionId).toBe("s1");
  });
});

describe("listVersions", () => {
  it("returns versions ordered desc by versionNum", async () => {
    mockSelect.mockReturnValue(chain([
      { id: "v3", versionNum: 3 },
      { id: "v2", versionNum: 2 },
      { id: "v1", versionNum: 1 },
    ]));
    const out = await listVersions("e1");
    expect(out).toHaveLength(3);
    expect(out[0].versionNum).toBe(3);
  });
});

describe("getVersion", () => {
  it("returns the version when found", async () => {
    mockSelect.mockReturnValue(chain([{ id: "v2", versionNum: 2, content: "x" }]));
    const v = await getVersion("e1", 2);
    expect(v?.id).toBe("v2");
  });

  it("returns null when not found", async () => {
    mockSelect.mockReturnValue(chain([]));
    expect(await getVersion("e1", 99)).toBeNull();
  });
});

describe("revertToVersion", () => {
  it("creates a new version with copied content and source='revert'", async () => {
    let appendCallArgs: any = null;

    // Top-level select for getVersion call (returns the target to revert to)
    mockSelect.mockReturnValue(chain([{ id: "v2", versionNum: 2, content: "old content" }]));

    const tx = {
      select: vi.fn(() => chain([{ id: "v5", versionNum: 5 }])),
      insert: vi.fn(() => ({
        values: vi.fn((v: any) => {
          appendCallArgs = v;
          return {
            returning: vi.fn(() => Promise.resolve([{ id: "v6", versionNum: 6 }])),
          };
        }),
      })),
      update: vi.fn(() => ({
        set: vi.fn(() => ({ where: vi.fn(() => Promise.resolve()) })),
      })),
    };
    mockTransaction.mockImplementation(async (fn: any) => fn(tx));

    const v = await revertToVersion("e1", 2, "u1", 5);
    expect(v.versionNum).toBe(6);
    expect(appendCallArgs.content).toBe("old content");
    expect(appendCallArgs.source).toBe("revert");
  });
});
