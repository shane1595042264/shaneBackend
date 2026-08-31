// tests/modules/courses/repo.test.ts
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
  courses: {
    id: {}, userId: {}, slug: {}, url: {}, title: {}, description: {},
    category: {}, difficulty: {}, durationMinutes: {}, tags: {},
    createdAt: {}, updatedAt: {},
  },
  courseCovers: {
    id: {}, courseId: {}, mimeType: {}, byteSize: {}, data: {},
    createdAt: {}, updatedAt: {},
  },
  courseRatings: {
    id: {}, courseId: {}, userId: {}, stars: {}, createdAt: {}, updatedAt: {},
  },
  courseComments: {
    id: {}, courseId: {}, parentCommentId: {}, authorId: {}, content: {},
    editedAt: {}, createdAt: {}, updatedAt: {},
  },
  users: { id: {}, name: {}, avatarUrl: {} },
}));

vi.mock("drizzle-orm", () => {
  const tag = (strings: TemplateStringsArray, ...vals: unknown[]) => ({ strings, vals });
  return {
    eq: vi.fn((a, b) => ({ a, b, op: "eq" })),
    and: vi.fn((...args: unknown[]) => ({ args, op: "and" })),
    asc: vi.fn((c) => ({ c, dir: "asc" })),
    desc: vi.fn((c) => ({ c, dir: "desc" })),
    sql: Object.assign(tag, { raw: (s: string) => s }),
    getTableColumns: vi.fn(() => ({
      id: {}, courseId: {}, parentCommentId: {}, authorId: {}, content: {},
      editedAt: {}, createdAt: {}, updatedAt: {},
    })),
  };
});

function chain(rows: unknown[]) {
  const c: Record<string, unknown> = {};
  const t = Promise.resolve(rows);
  for (const m of ["from", "where", "orderBy", "limit", "groupBy", "leftJoin", "innerJoin"]) {
    c[m] = vi.fn(() => c);
  }
  Object.assign(c, {
    then: (r: (v: unknown) => unknown, j: (e: unknown) => unknown) => t.then(r, j),
  });
  return c;
}

function insertChain(returningRows: unknown[]) {
  const returning = vi.fn(() => Promise.resolve(returningRows));
  const onConflictDoUpdate = vi.fn(() => Promise.resolve(undefined));
  const values = vi.fn(() => ({ returning, onConflictDoUpdate }));
  return { chain: { values }, values, returning, onConflictDoUpdate };
}

function updateChain(returningRows: unknown[]) {
  const returning = vi.fn(() => Promise.resolve(returningRows));
  const where = vi.fn(() => ({
    returning,
    then: (r: (v: unknown) => unknown) => Promise.resolve(returningRows).then(r),
  }));
  const set = vi.fn(() => ({ where }));
  return { chain: { set }, set, where, returning };
}

function deleteChain(returningRows: unknown[]) {
  const returning = vi.fn(() => Promise.resolve(returningRows));
  const where = vi.fn(() => ({
    returning,
    then: (r: (v: unknown) => unknown) => Promise.resolve(returningRows).then(r),
  }));
  return { chain: { where }, where, returning };
}

import {
  createCourse,
  listCourses,
  getCourseById,
  slugTaken,
  updateCourse,
  deleteCourse,
  upsertRating,
  ratingSummaryFor,
  myRatingFor,
  deleteCourseComment,
  listCourseComments,
} from "@/modules/courses/repo";

beforeEach(() => vi.clearAllMocks());

const courseRow = {
  id: "c1", userId: "u1", slug: "pi2-heist", url: "https://x/courses/pi2-heist/",
  title: "The Pi/2 Heist", description: "d", category: "math", difficulty: "advanced",
  durationMinutes: 28, tags: ["integrals"], createdAt: new Date(), updatedAt: new Date(),
};

describe("createCourse", () => {
  it("inserts the row and returns it", async () => {
    const ic = insertChain([courseRow]);
    mockInsert.mockReturnValue(ic.chain);
    const out = await createCourse({
      userId: "u1", slug: "pi2-heist", url: courseRow.url, title: courseRow.title,
      description: "d", category: "math", difficulty: "advanced", durationMinutes: 28,
      tags: ["integrals"],
    });
    expect(ic.values.mock.calls[0][0]).toMatchObject({ userId: "u1", slug: "pi2-heist", category: "math" });
    expect(out).toEqual(courseRow);
  });
});

describe("listCourses / getCourseById / slugTaken", () => {
  it("lists newest first", async () => {
    mockSelect.mockReturnValue(chain([courseRow]));
    await expect(listCourses()).resolves.toEqual([courseRow]);
  });
  it("returns null when missing", async () => {
    mockSelect.mockReturnValue(chain([]));
    await expect(getCourseById("nope")).resolves.toBeNull();
  });
  it("slugTaken true when a row exists", async () => {
    mockSelect.mockReturnValue(chain([{ id: "c1" }]));
    await expect(slugTaken("pi2-heist")).resolves.toBe(true);
  });
});

describe("updateCourse / deleteCourse ownership", () => {
  it("update returns null when no row matched (non-owner)", async () => {
    const uc = updateChain([]);
    mockUpdate.mockReturnValue(uc.chain);
    await expect(updateCourse("c1", "intruder", { title: "x" })).resolves.toBeNull();
  });
  it("delete returns true when a row was removed", async () => {
    const dc = deleteChain([{ id: "c1" }]);
    mockDelete.mockReturnValue(dc.chain);
    await expect(deleteCourse("c1", "u1")).resolves.toBe(true);
  });
});

describe("ratings", () => {
  it("upsertRating uses onConflictDoUpdate", async () => {
    const ic = insertChain([]);
    mockInsert.mockReturnValue(ic.chain);
    await upsertRating("c1", "u1", 5);
    expect(ic.values.mock.calls[0][0]).toMatchObject({ courseId: "c1", userId: "u1", stars: 5 });
    expect(ic.onConflictDoUpdate).toHaveBeenCalled();
  });
  it("ratingSummaryFor returns zeroes when unrated", async () => {
    mockSelect.mockReturnValue(chain([]));
    await expect(ratingSummaryFor("c1")).resolves.toEqual({ average: null, count: 0 });
  });
  it("myRatingFor returns stars or null", async () => {
    mockSelect.mockReturnValue(chain([{ stars: 4 }]));
    await expect(myRatingFor("c1", "u1")).resolves.toBe(4);
    mockSelect.mockReturnValue(chain([]));
    await expect(myRatingFor("c1", "u1")).resolves.toBeNull();
  });
});

describe("comments", () => {
  it("listCourseComments reshapes the author join", async () => {
    mockSelect.mockReturnValue(
      chain([
        {
          id: "k1", courseId: "c1", parentCommentId: null, authorId: "u2",
          content: "Nice", editedAt: null, createdAt: new Date(), updatedAt: new Date(),
          authorName: "Ava", authorAvatarUrl: null,
        },
      ]),
    );
    const [c] = await listCourseComments("c1");
    expect(c.author).toEqual({ id: "u2", name: "Ava", avatarUrl: null });
    expect("authorName" in c).toBe(false);
  });

  it("deleteCourseComment allows the course owner", async () => {
    mockSelect.mockReturnValue(
      chain([{ commentId: "k1", commentAuthor: "u2", courseOwner: "u1" }]),
    );
    const dc = deleteChain([]);
    mockDelete.mockReturnValue(dc.chain);
    await expect(deleteCourseComment("k1", "u1")).resolves.toBe(true);
    expect(mockDelete).toHaveBeenCalled();
  });

  it("deleteCourseComment refuses a stranger", async () => {
    mockSelect.mockReturnValue(
      chain([{ commentId: "k1", commentAuthor: "u2", courseOwner: "u1" }]),
    );
    await expect(deleteCourseComment("k1", "stranger")).resolves.toBe(false);
    expect(mockDelete).not.toHaveBeenCalled();
  });
});
