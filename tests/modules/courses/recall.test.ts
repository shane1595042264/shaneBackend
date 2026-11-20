// tests/modules/courses/recall.test.ts
import { describe, it, expect } from "vitest";
import type { CourseContent, CourseStep } from "@/modules/courses/content-schema";
import { drawRecall, lessonStanding, recallPool, recallUnlocksAt, RECALL_GAP_MS } from "@/modules/courses/recall";

const choice = (n: number): CourseStep =>
  ({ type: "choice", prompt: `Q${n}`, choices: [{ text: "a", correct: true }, { text: "b" }] }) as CourseStep;
const recite = (n: number): CourseStep => ({ type: "recite", prompt: `R${n}`, answer: `A${n}` }) as CourseStep;
const teach: CourseStep = { type: "teach", body: "x", visual: { kind: "emoji", emoji: "🧭" } } as CourseStep;
const match: CourseStep = { type: "match", pairs: [["a", "b"], ["c", "d"]] } as CourseStep;

function course(lessons: CourseStep[][], examAt?: number): CourseContent {
  return {
    version: 1,
    units: [
      {
        id: "u",
        title: "U",
        lessons: lessons.map((steps, i) => ({
          id: `l${i}`,
          title: `L${i}`,
          ...(i === examAt ? { exam: { passMark: 80 } } : {}),
          steps,
        })),
      },
    ],
  };
}

describe("recallPool", () => {
  it("takes every exercise but match", () => {
    const pool = recallPool(course([[teach, choice(1), match, recite(1)]]));
    expect(pool.map((c) => [c.lessonId, c.index])).toEqual([
      ["l0", 1],
      ["l0", 3],
    ]);
  });
});

describe("drawRecall", () => {
  const big = course(Array.from({ length: 12 }, (_, i) => [teach, choice(i * 3), choice(i * 3 + 1), recite(i)]));

  it("asks about every lesson, sized by the lesson count", () => {
    const cards = drawRecall(big, "seed");
    expect(cards).toHaveLength(12);
    expect(new Set(cards.map((c) => c.lessonId)).size).toBe(12);
  });

  it("asks at least 8 when the pool has them", () => {
    const two = course([[choice(1), choice(2), choice(3), recite(1)], [choice(4), choice(5), recite(2), recite(3)]]);
    const cards = drawRecall(two, "s");
    expect(cards).toHaveLength(8);
    expect(new Set(cards.map((c) => `${c.lessonId}:${c.index}`)).size).toBe(8);
  });

  it("never asks more than the pool holds", () => {
    expect(drawRecall(course([[choice(1), recite(1)]]), "s")).toHaveLength(2);
  });

  it("is the same for the same seed and differs for another", () => {
    const key = (seed: string) => drawRecall(big, seed).map((c) => `${c.lessonId}:${c.index}`).join(",");
    expect(key("a")).toBe(key("a"));
    expect(key("a")).not.toBe(key("b"));
  });

  it("leans on recitals", () => {
    let recitals = 0;
    for (let i = 0; i < 200; i++) {
      recitals += drawRecall(big, `s${i}`).filter((c) => c.step.type === "recite").length;
    }
    // A recital is 1 card in 3; weighted 4:1 it is picked about two times in three.
    expect(recitals / (200 * 12)).toBeGreaterThan(0.55);
  });
});

describe("lessonStanding", () => {
  const content = course([[choice(1)], [recite(1)]], 1);
  const t = (iso: string) => new Date(iso);

  it("counts an exam only once passed, and the latest activity on any lesson", () => {
    const s = lessonStanding(
      content,
      [{ lessonId: "l0", bestScore: 100, updatedAt: t("2026-11-01T00:00:00Z") }],
      [{ lessonId: "l1", bestScore: 70, updatedAt: t("2026-11-02T00:00:00Z") }],
    );
    expect(s.missing).toEqual(["l1"]);
    expect(s.lastActivity).toEqual(t("2026-11-02T00:00:00Z"));
  });

  it("ignores rows for lessons the course no longer has", () => {
    const s = lessonStanding(
      content,
      [
        { lessonId: "l0", bestScore: 100, updatedAt: t("2026-11-01T00:00:00Z") },
        { lessonId: "gone", bestScore: 100, updatedAt: t("2026-11-09T00:00:00Z") },
      ],
      [{ lessonId: "l1", bestScore: 90, updatedAt: t("2026-11-02T00:00:00Z") }],
    );
    expect(s.missing).toEqual([]);
    expect(s.lastActivity).toEqual(t("2026-11-02T00:00:00Z"));
  });
});

describe("recallUnlocksAt", () => {
  it("is a day after the later of the last lesson and the last failed sitting", () => {
    const a = new Date("2026-11-01T00:00:00Z");
    const b = new Date("2026-11-03T00:00:00Z");
    expect(recallUnlocksAt(a, b).getTime()).toBe(b.getTime() + RECALL_GAP_MS);
    expect(recallUnlocksAt(b, null).getTime()).toBe(b.getTime() + RECALL_GAP_MS);
  });
});
