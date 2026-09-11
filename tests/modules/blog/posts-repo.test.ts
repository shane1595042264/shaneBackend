// tests/modules/blog/posts-repo.test.ts — SHAN-478 Phase 1
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
// Column refs have to be defined objects, not undefined: the assertions below
// use expect.anything() on the column argument, which does not match undefined.
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
  or: vi.fn((...a: unknown[]) => ({ or: a })),
  desc: vi.fn((c: unknown) => ({ c, dir: "desc" })),
  lt: vi.fn((c: unknown, v: unknown) => ({ lt: [c, v] })),
  ilike: vi.fn((c: unknown, v: unknown) => ({ ilike: [c, v] })),
  sql: Object.assign(
    vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({
      __sql: strings.join("?"),
      values,
    })),
    { raw: vi.fn() }
  ),
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
  hashContent,
  createPost,
  getPostBySlug,
  listPosts,
  slugTaken,
  softDeletePost,
  updatePostMeta,
} from "@/modules/blog/posts-repo";

beforeEach(() => vi.clearAllMocks());

describe("hashContent", () => {
  it("is a stable sha256 hex digest", () => {
    expect(hashContent("hello")).toBe(hashContent("hello"));
    expect(hashContent("hello")).toHaveLength(64);
    expect(hashContent("hello")).not.toBe(hashContent("hello "));
  });
});

describe("createPost", () => {
  it("inserts the post and version 1, then points currentVersionId at it", async () => {
    const tx = {
      insert: vi
        .fn()
        .mockReturnValueOnce({
          values: vi.fn(() => ({
            returning: vi.fn(() =>
              Promise.resolve([{ id: "p1", slug: "hello-world", currentVersionId: null }])
            ),
          })),
        })
        .mockReturnValueOnce({
          values: vi.fn(() => ({
            returning: vi.fn(() => Promise.resolve([{ id: "v1", versionNum: 1 }])),
          })),
        }),
      update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(() => Promise.resolve()) })) })),
    };
    mockTransaction.mockImplementation(async (fn: any) => fn(tx));

    const result = await createPost({
      slug: "hello-world",
      title: "Hello World",
      authorId: "u1",
      content: "body",
    });

    expect(result.post.currentVersionId).toBe("v1");
    expect(result.version.versionNum).toBe(1);
    expect(tx.insert).toHaveBeenCalledTimes(2);
    expect(tx.update).toHaveBeenCalledTimes(1);
  });

  it("defaults timezone, tags and status when omitted", async () => {
    const postValues = vi.fn(() => ({
      returning: vi.fn(() => Promise.resolve([{ id: "p1" }])),
    }));
    const tx = {
      insert: vi
        .fn()
        .mockReturnValueOnce({ values: postValues })
        .mockReturnValueOnce({
          values: vi.fn(() => ({
            returning: vi.fn(() => Promise.resolve([{ id: "v1", versionNum: 1 }])),
          })),
        }),
      update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(() => Promise.resolve()) })) })),
    };
    mockTransaction.mockImplementation(async (fn: any) => fn(tx));

    await createPost({ slug: "s", title: "T", authorId: "u1", content: "c" });

    expect(postValues).toHaveBeenCalledWith(
      expect.objectContaining({
        authorTimezone: "America/Chicago",
        tags: [],
        status: "published",
      })
    );
  });
});

describe("getPostBySlug", () => {
  it("returns the post with a flattened author for a published row", async () => {
    mockSelect.mockReturnValue(
      chain([
        {
          post: { id: "p1", authorId: "u1", status: "published" },
          currentVersion: { versionNum: 2, content: "body" },
          authorName: "Shane",
          authorAvatarUrl: "http://a/x.png",
        },
      ])
    );
    const row = await getPostBySlug("hello-world");
    expect(row?.author).toEqual({ id: "u1", name: "Shane", avatarUrl: "http://a/x.png" });
    expect(row?.currentVersion?.content).toBe("body");
  });

  it("returns null when the slug does not exist", async () => {
    mockSelect.mockReturnValue(chain([]));
    expect(await getPostBySlug("nope")).toBeNull();
  });

  it("hides a trashed post even from its own author", async () => {
    mockSelect.mockReturnValue(
      chain([{ post: { id: "p1", authorId: "u1", status: "trashed" }, currentVersion: null }])
    );
    expect(await getPostBySlug("gone", "u1")).toBeNull();
  });

  it("hides a draft from anonymous readers and other users", async () => {
    mockSelect.mockReturnValue(
      chain([{ post: { id: "p1", authorId: "u1", status: "draft" }, currentVersion: null }])
    );
    expect(await getPostBySlug("wip")).toBeNull();

    mockSelect.mockReturnValue(
      chain([{ post: { id: "p1", authorId: "u1", status: "draft" }, currentVersion: null }])
    );
    expect(await getPostBySlug("wip", "u2")).toBeNull();
  });

  it("shows a draft to its own author", async () => {
    mockSelect.mockReturnValue(
      chain([
        {
          post: { id: "p1", authorId: "u1", status: "draft" },
          currentVersion: { versionNum: 1, content: "wip" },
          authorName: "Shane",
          authorAvatarUrl: null,
        },
      ])
    );
    const row = await getPostBySlug("wip", "u1");
    expect(row?.post.id).toBe("p1");
  });
});

describe("listPosts", () => {
  it("flattens the author and preserves row fields", async () => {
    mockSelect.mockReturnValue(
      chain([
        {
          id: "p1",
          slug: "a",
          authorId: "u1",
          publishedAt: new Date("2026-09-01T00:00:00Z"),
          authorName: "Shane",
          authorAvatarUrl: null,
        },
      ])
    );
    const rows = await listPosts({ limit: 20 });
    expect(rows[0].author).toEqual({ id: "u1", name: "Shane", avatarUrl: null });
    expect(rows[0]).not.toHaveProperty("authorName");
  });

  it("escapes LIKE wildcards in the search term", async () => {
    const c = chain([]);
    mockSelect.mockReturnValue(c);
    const { ilike } = await import("drizzle-orm");
    await listPosts({ limit: 20, q: "100%_off" });
    expect(ilike).toHaveBeenCalledWith(expect.anything(), "%100\\%\\_off%");
  });

  it("applies a keyset cursor when given one", async () => {
    mockSelect.mockReturnValue(chain([]));
    const { lt } = await import("drizzle-orm");
    const cursor = new Date("2026-09-01T00:00:00Z");
    await listPosts({ limit: 20, cursorPublishedAt: cursor });
    expect(lt).toHaveBeenCalledWith(expect.anything(), cursor);
  });

  it("restricts to published only when no viewer is supplied", async () => {
    mockSelect.mockReturnValue(chain([]));
    const { or, eq } = await import("drizzle-orm");
    await listPosts({ limit: 20 });
    expect(or).not.toHaveBeenCalled();
    expect(eq).toHaveBeenCalledWith(expect.anything(), "published");
  });

  it("widens to the viewer's own drafts when an author id is supplied", async () => {
    mockSelect.mockReturnValue(chain([]));
    const { or, eq } = await import("drizzle-orm");
    await listPosts({ limit: 20, includeDraftsForAuthorId: "u1" });
    expect(or).toHaveBeenCalled();
    expect(eq).toHaveBeenCalledWith(expect.anything(), "draft");
    expect(eq).toHaveBeenCalledWith(expect.anything(), "u1");
  });
});

describe("updatePostMeta", () => {
  function updateChain(rows: unknown[]) {
    const set = vi.fn();
    const returning = vi.fn(() => Promise.resolve(rows));
    const where = vi.fn(() => ({ returning }));
    set.mockImplementation(() => ({ where }));
    mockUpdate.mockReturnValue({ set });
    return { set };
  }

  it("writes tags when supplied", async () => {
    const { set } = updateChain([{ id: "p1" }]);
    await updatePostMeta("a", "u1", { tags: ["x", "y"] });
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ tags: ["x", "y"] }));
  });

  it("only bumps published_at conditionally, never with a bare timestamp", async () => {
    const { set } = updateChain([{ id: "p1" }]);
    await updatePostMeta("a", "u1", { status: "published" });
    const arg = set.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.status).toBe("published");
    // The guard is a SQL CASE on the OLD status, not `new Date()` — otherwise
    // re-saving an already-published post would jump it to the top of the index.
    expect(arg.publishedAt).not.toBeInstanceOf(Date);
    expect(String((arg.publishedAt as any).__sql)).toContain("case when");
  });

  it("does not touch published_at when unpublishing", async () => {
    const { set } = updateChain([{ id: "p1" }]);
    await updatePostMeta("a", "u1", { status: "draft" });
    expect(set.mock.calls[0][0]).not.toHaveProperty("publishedAt");
  });

  it("returns null when no row matched (wrong author)", async () => {
    updateChain([]);
    expect(await updatePostMeta("a", "someone-else", { tags: [] })).toBeNull();
  });
});

describe("softDeletePost", () => {
  it("returns true when a row was trashed", async () => {
    mockUpdate.mockReturnValue({
      set: vi.fn(() => ({
        where: vi.fn(() => ({ returning: vi.fn(() => Promise.resolve([{ id: "p1" }])) })),
      })),
    });
    expect(await softDeletePost("a", "u1")).toBe(true);
  });

  it("returns false when the slug is missing or owned by someone else", async () => {
    mockUpdate.mockReturnValue({
      set: vi.fn(() => ({
        where: vi.fn(() => ({ returning: vi.fn(() => Promise.resolve([])) })),
      })),
    });
    expect(await softDeletePost("a", "u2")).toBe(false);
  });
});

describe("slugTaken", () => {
  it("is true when a row comes back", async () => {
    mockSelect.mockReturnValue(chain([{ id: "p1" }]));
    expect(await slugTaken("a")).toBe(true);
  });

  it("is false when nothing matches", async () => {
    mockSelect.mockReturnValue(chain([]));
    expect(await slugTaken("a")).toBe(false);
  });
});
