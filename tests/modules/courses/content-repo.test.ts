// tests/modules/courses/content-repo.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDelete, deletes } = vi.hoisted(() => {
  const deletes: { table: unknown; where: unknown }[] = [];
  const mockDelete = vi.fn((table: unknown) => ({
    where: vi.fn(async (where: unknown) => {
      deletes.push({ table, where });
    }),
  }));
  return { mockDelete, deletes };
});

vi.mock("@/db/client", () => ({ db: { delete: mockDelete } }));

vi.mock("@/db/schema", () => ({
  courseContent: { courseId: {} },
  courseProgress: { name: "progress", userId: {}, courseId: {} },
  courseExamResults: { name: "exams", userId: {}, courseId: {}, updatedAt: {} },
  courseRecallResults: { name: "recall", userId: {}, courseId: {}, passedAt: { col: "passedAt" } },
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((a, b) => ({ a, b, op: "eq" })),
  and: vi.fn((...args: unknown[]) => ({ args, op: "and" })),
  lte: vi.fn((a, b) => ({ a, b, op: "lte" })),
  isNull: vi.fn((a) => ({ a, op: "isNull" })),
  isNotNull: vi.fn((a) => ({ a, op: "isNotNull" })),
  inArray: vi.fn((a, b) => ({ a, b, op: "inArray" })),
  sql: Object.assign(() => ({}), { raw: (s: string) => s }),
}));

import { resetProgress } from "@/modules/courses/content-repo";

describe("resetProgress", () => {
  beforeEach(() => {
    deletes.length = 0;
    mockDelete.mockClear();
  });

  // SHAN-727: the failed sitting's attempts seed the next draw, so deleting it
  // would serve the first sitting's cards again.
  it("keeps a recall check that has not been passed", async () => {
    await resetProgress("learner", "course-1");
    const recall = deletes.find((d) => (d.table as { name: string }).name === "recall");
    expect(recall).toBeDefined();
    const where = recall!.where as { op: string; args: { op: string; a: unknown; b?: unknown }[] };
    expect(where.op).toBe("and");
    expect(where.args).toContainEqual({ a: { col: "passedAt" }, op: "isNotNull" });
    expect(where.args).toContainEqual({ a: {}, b: "learner", op: "eq" });
    expect(where.args).toContainEqual({ a: {}, b: "course-1", op: "eq" });
  });

  it("still clears practice progress outright", async () => {
    await resetProgress("learner", "course-1");
    const progress = deletes.find((d) => (d.table as { name: string }).name === "progress");
    const where = progress!.where as { args: { op: string }[] };
    expect(where.args.map((a) => a.op)).toEqual(["eq", "eq"]);
  });
});
