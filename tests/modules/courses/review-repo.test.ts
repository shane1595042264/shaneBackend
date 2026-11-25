// tests/modules/courses/review-repo.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockUpdate, updates } = vi.hoisted(() => {
  const updates: { table: unknown; set: unknown; where: unknown }[] = [];
  const mockUpdate = vi.fn((table: unknown) => ({
    set: vi.fn((set: unknown) => {
      const entry = { table, set, where: undefined as unknown };
      updates.push(entry);
      const where = vi.fn((w: unknown) => {
        entry.where = w;
        // Awaited directly (supersedePendingReviews) or via .returning()
        // (certifyIfLatest); both resolve to one written row.
        return Object.assign(Promise.resolve([{ id: "row" }]), {
          returning: vi.fn(async () => [{ id: "row" }]),
        });
      });
      return { where };
    }),
  }));
  return { mockUpdate, updates };
});

vi.mock("@/db/client", () => ({ db: { update: mockUpdate } }));

vi.mock("@/db/schema", () => ({
  courses: { name: "courses", id: { col: "courses.id" }, visibility: { col: "courses.visibility" } },
  courseReviews: { name: "reviews", courseId: { col: "reviews.courseId" }, status: { col: "reviews.status" } },
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((a, b) => ({ a, b, op: "eq" })),
  ne: vi.fn((a, b) => ({ a, b, op: "ne" })),
  and: vi.fn((...args: unknown[]) => ({ args: args.filter((x) => x !== undefined), op: "and" })),
  asc: vi.fn(),
  desc: vi.fn(),
  isNull: vi.fn(),
  lt: vi.fn(),
  or: vi.fn(),
  sql: Object.assign(() => ({ op: "sql" }), { raw: (s: string) => s }),
}));

import { certifyIfLatest, supersedePendingReviews } from "@/modules/courses/review-repo";

type Where = { op: string; args: { op: string; a?: unknown; b?: unknown }[] };

beforeEach(() => {
  updates.length = 0;
  mockUpdate.mockClear();
});

// SHAN-740: editing a private course's lessons queues no newer review, so
// "this review is still the latest" cannot by itself stop an old verdict.
describe("certifyIfLatest", () => {
  it("will not certify a private course", async () => {
    await certifyIfLatest("c1", "r1", true);
    const where = updates[0].where as Where;
    expect(where.args).toContainEqual({ a: { col: "courses.visibility" }, b: "private", op: "ne" });
    expect(where.args).toContainEqual({ a: { col: "courses.id" }, b: "c1", op: "eq" });
  });

  it("can still uncertify one", async () => {
    await certifyIfLatest("c1", "r1", false);
    const where = updates[0].where as Where;
    expect(where.args.map((a) => a.op)).not.toContain("ne");
    expect(updates[0].set).toMatchObject({ certified: false });
  });
});

describe("supersedePendingReviews", () => {
  it("retires only the course's pending reviews", async () => {
    await supersedePendingReviews("c1");
    expect(updates[0].table).toMatchObject({ name: "reviews" });
    expect(updates[0].set).toEqual({ status: "superseded" });
    const where = updates[0].where as Where;
    expect(where.args).toEqual([
      { a: { col: "reviews.courseId" }, b: "c1", op: "eq" },
      { a: { col: "reviews.status" }, b: "pending", op: "eq" },
    ]);
  });
});
