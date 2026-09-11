// tests/modules/blog/versions-repo.test.ts — SHAN-478 Phase 1
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
vi.mock("@/db/schema", () => {
  const table = (name: string) =>
    new Proxy({} as Record<string, unknown>, {
      get: (_t, prop) => ({ table: name, column: String(prop) }),
    });
  return {
    blogPosts: table("blog_posts"),
    blogVersions: table("blog_versions"),
    users: table("users"),
  };
});
vi.mock("drizzle-orm", () => ({
  eq: vi.fn((c: unknown, v: unknown) => ({ eq: [c, v] })),
  and: vi.fn((...a: unknown[]) => ({ and: a })),
  desc: vi.fn((c: unknown) => ({ c, dir: "desc" })),
  lt: vi.fn((c: unknown, v: unknown) => ({ lt: [c, v] })),
  sql: vi.fn(() => ({ __sql: true })),
  getTableColumns: vi.fn(() => ({})),
}));

function chain(rows: unknown[]) {
  const c: Record<string, unknown> = {};
  const t = Promise.resolve(rows);
  for (const m of ["from", "where", "orderBy", "limit", "leftJoin"]) c[m] = vi.fn(() => c);
  Object.assign(c, { then: (r: any, j: any) => t.then(r, j) });
  return c;
}

import {
  appendDirectVersion,
  listVersions,
  getVersion,
  revertToVersion,
  VersionConflictError,
} from "@/modules/blog/versions-repo";

beforeEach(() => vi.clearAllMocks());

function txWith(latest: unknown[], inserted: unknown = { id: "v4", versionNum: 4 }) {
  const setSpy = vi.fn(() => ({ where: vi.fn(() => Promise.resolve()) }));
  const valuesSpy = vi.fn(() => ({ returning: vi.fn(() => Promise.resolve([inserted])) }));
  const tx = {
    select: vi.fn(() => chain(latest)),
    insert: vi.fn(() => ({ values: valuesSpy })),
    update: vi.fn(() => ({ set: setSpy })),
  };
  mockTransaction.mockImplementation(async (fn: any) => fn(tx));
  return { tx, setSpy, valuesSpy };
}

describe("appendDirectVersion", () => {
  it("inserts versionNum = current + 1 and links the parent version", async () => {
    const { valuesSpy } = txWith([{ id: "v3", versionNum: 3 }]);
    const v = await appendDirectVersion({
      postId: "p1",
      editorId: "u1",
      title: "New title",
      content: "new body",
      ifMatchVersionNum: 3,
    });
    expect(v.versionNum).toBe(4);
    expect(valuesSpy).toHaveBeenCalledWith(
      expect.objectContaining({ versionNum: 4, parentVersionId: "v3", source: "direct" })
    );
  });

  it("keeps the denormalized blog_posts.title in step with the new version", async () => {
    const { setSpy } = txWith([{ id: "v1", versionNum: 1 }]);
    await appendDirectVersion({
      postId: "p1",
      editorId: "u1",
      title: "Renamed",
      content: "body",
      ifMatchVersionNum: 1,
    });
    expect(setSpy).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Renamed", currentVersionId: "v4" })
    );
  });

  it("throws VersionConflictError when If-Match is stale", async () => {
    txWith([{ id: "v5", versionNum: 5 }]);
    await expect(
      appendDirectVersion({
        postId: "p1",
        editorId: "u1",
        title: "t",
        content: "c",
        ifMatchVersionNum: 3,
      })
    ).rejects.toMatchObject({ name: "VersionConflict", currentVersionNum: 5 });
  });

  it("throws VersionConflictError with 0 when the post has no versions", async () => {
    txWith([]);
    await expect(
      appendDirectVersion({
        postId: "p1",
        editorId: "u1",
        title: "t",
        content: "c",
        ifMatchVersionNum: 1,
      })
    ).rejects.toMatchObject({ currentVersionNum: 0 });
  });
});

describe("listVersions", () => {
  it("flattens the editor and never selects the body", async () => {
    const c = chain([
      { id: "v2", postId: "p1", versionNum: 2, editorId: "u1", editorName: "Shane", editorAvatarUrl: null },
    ]);
    mockSelect.mockReturnValue(c);
    const rows = await listVersions("p1", { limit: 50 });
    expect(rows[0].editor).toEqual({ id: "u1", name: "Shane", avatarUrl: null });
    expect(rows[0]).not.toHaveProperty("content");
    // The projection passed to .select() must not carry a content column:
    // versions are never pruned, so listing bodies grows without bound.
    expect(Object.keys(mockSelect.mock.calls[0][0] as object)).not.toContain("content");
  });

  it("applies the versionNum keyset cursor", async () => {
    mockSelect.mockReturnValue(chain([]));
    const { lt } = await import("drizzle-orm");
    await listVersions("p1", { limit: 50, cursor: 7 });
    expect(lt).toHaveBeenCalledWith(expect.anything(), 7);
  });

  it("omits the cursor condition when none is given", async () => {
    mockSelect.mockReturnValue(chain([]));
    const { lt } = await import("drizzle-orm");
    await listVersions("p1", { limit: 50 });
    expect(lt).not.toHaveBeenCalled();
  });
});

describe("getVersion", () => {
  it("returns null when the version number does not exist", async () => {
    mockSelect.mockReturnValue(chain([]));
    expect(await getVersion("p1", 99)).toBeNull();
  });
});

describe("revertToVersion", () => {
  it("re-appends the target's title and body as a new version tagged 'revert'", async () => {
    mockSelect.mockReturnValue(chain([{ id: "v1", versionNum: 1, title: "Old", content: "old body" }]));
    const { valuesSpy } = txWith([{ id: "v3", versionNum: 3 }]);
    await revertToVersion("p1", 1, "u1", 3);
    expect(valuesSpy).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Old", content: "old body", source: "revert", versionNum: 4 })
    );
  });

  it("throws when the target version is missing", async () => {
    mockSelect.mockReturnValue(chain([]));
    await expect(revertToVersion("p1", 42, "u1", 3)).rejects.toThrow("Target version not found");
  });
});
