import { describe, it, expect } from "vitest";
import { applyGrade, type VocabIntervals } from "@/modules/practice/vocab-srs";

const INTERVALS: VocabIntervals = {
  intervalL1Days: 1,
  intervalL2Days: 3,
  lapseIntervalDays: 1,
  levelToMemorize: 3,
};
const NOW = new Date("2026-07-24T12:00:00Z");
const NEW = { level: 0, dueAt: null, memorizedAt: null };
const daysFrom = (d: Date, n: number) => new Date(d.getTime() + n * 86400000);

describe("applyGrade", () => {
  it("remember on a new word → level 1, due in +1 day, not memorized", () => {
    const t = applyGrade(NEW, "remember", INTERVALS, NOW);
    expect(t.level).toBe(1);
    expect(t.dueAt).toEqual(daysFrom(NOW, 1));
    expect(t.memorizedAt).toBeNull();
    expect(t.justMemorized).toBe(false);
  });

  it("remember at level 1 → level 2, due in +3 days", () => {
    const t = applyGrade({ level: 1, dueAt: NOW, memorizedAt: null }, "remember", INTERVALS, NOW);
    expect(t.level).toBe(2);
    expect(t.dueAt).toEqual(daysFrom(NOW, 3));
    expect(t.justMemorized).toBe(false);
  });

  it("remember at level 2 → level 3 memorized: due cleared, memorizedAt set, justMemorized true", () => {
    const t = applyGrade({ level: 2, dueAt: NOW, memorizedAt: null }, "remember", INTERVALS, NOW);
    expect(t.level).toBe(3);
    expect(t.dueAt).toBeNull();
    expect(t.memorizedAt).toEqual(NOW);
    expect(t.justMemorized).toBe(true);
  });

  it("forget at level 2 → drop to level 1, due in +1 day (lapse), not memorized", () => {
    const t = applyGrade({ level: 2, dueAt: NOW, memorizedAt: null }, "forget", INTERVALS, NOW);
    expect(t.level).toBe(1);
    expect(t.dueAt).toEqual(daysFrom(NOW, 1));
    expect(t.memorizedAt).toBeNull();
    expect(t.justMemorized).toBe(false);
  });

  it("forget at level 0 → stays at 0 (never negative)", () => {
    const t = applyGrade(NEW, "forget", INTERVALS, NOW);
    expect(t.level).toBe(0);
    expect(t.dueAt).toEqual(daysFrom(NOW, 1));
  });

  it("respects a custom levelToMemorize of 2", () => {
    const two = { ...INTERVALS, levelToMemorize: 2 };
    const t = applyGrade({ level: 1, dueAt: NOW, memorizedAt: null }, "remember", two, NOW);
    expect(t.level).toBe(2);
    expect(t.justMemorized).toBe(true);
    expect(t.dueAt).toBeNull();
  });

  it("re-grading an already-memorized word does not re-fire justMemorized (idempotent)", () => {
    const t = applyGrade({ level: 3, dueAt: null, memorizedAt: NOW }, "remember", INTERVALS, NOW);
    expect(t.level).toBe(3);
    expect(t.justMemorized).toBe(false);
  });
});
