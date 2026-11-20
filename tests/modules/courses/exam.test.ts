// tests/modules/courses/exam.test.ts
// SHAN-721: recite steps, exam lessons, answer stripping and server grading.
import { describe, it, expect, vi } from "vitest";
import {
  certificationGaps,
  validateCourseContent,
  type CourseContent,
  type CourseLesson,
} from "@/modules/courses/content-schema";
import { examStepView, gradeExam, gradeStep, withoutExamAnswers } from "@/modules/courses/exam";

const choice = {
  type: "choice",
  prompt: "Pick one",
  choices: [{ text: "Right", correct: true, why: "Because" }, { text: "Wrong" }],
  explanation: "Right is right.",
};
const recite = { type: "recite", prompt: "What is ACID?", answer: "Atomicity, consistency, isolation, durability" };
const blank = { type: "blank", text: "The [[collector|the collector]] takes the [[hit]].", bank: ["warehouse"] };
const typedBlank = { type: "blank", text: "The [[collector|the collector]] takes the hit." };
const order = { type: "order", prompt: "Order them", items: ["one", "two", "three", "four"] };

function doc(steps: unknown[], extra: Record<string, unknown> = {}) {
  return { units: [{ title: "Unit", lessons: [{ title: "Lesson", steps, ...extra }] }] };
}

function valid(input: unknown): CourseContent {
  const r = validateCourseContent(input);
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.content;
}

function issues(input: unknown) {
  const r = validateCourseContent(input);
  if (r.ok) throw new Error("expected invalid");
  return r.issues;
}

const lessonOf = (c: CourseContent) => c.units[0].lessons[0];

describe("recite steps and exams in the format", () => {
  it("accepts a recite step and counts it as an exercise", () => {
    const c = valid(doc([recite]));
    expect(lessonOf(c).steps[0]).toMatchObject({ type: "recite", answer: recite.answer });
  });

  it("requires a recite step's prompt and answer", () => {
    const found = issues(doc([{ type: "recite", prompt: "Say it" }]));
    expect(found[0].path).toBe("units[0].lessons[0].steps[0].answer");
  });

  it("names recite among the step types", () => {
    expect(issues(doc([{ type: "essay" }]))[0].message).toContain('"recite"');
  });

  it("fills in the default pass mark and keeps exam on the lesson", () => {
    expect(lessonOf(valid(doc([choice], { exam: {} }))).exam).toEqual({ passMark: 80 });
    expect(lessonOf(valid(doc([choice], { exam: { passMark: 90 } }))).exam).toEqual({ passMark: 90 });
    expect(lessonOf(valid(doc([choice]))).exam).toBeUndefined();
  });

  it("bounds the pass mark", () => {
    expect(issues(doc([choice], { exam: { passMark: 30 } }))[0].path).toBe("units[0].lessons[0].exam.passMark");
    expect(issues(doc([choice], { exam: { passMark: 101 } })).length).toBe(1);
  });

  it("keeps match steps out of an exam", () => {
    const match = { type: "match", pairs: [["a", "1"], ["b", "2"]] };
    expect(lessonOf(valid(doc([match]))).steps).toHaveLength(1);
    const found = issues(doc([choice, match], { exam: {} }));
    expect(found[0].path).toBe("units[0].lessons[0].steps[1].type");
  });
});

describe("certificationGaps", () => {
  it("asks for a recite step and an exam", () => {
    expect(certificationGaps(valid(doc([choice])))).toEqual(["at least one recite step", "an exam lesson"]);
    expect(certificationGaps(valid(doc([recite])))).toEqual(["an exam lesson"]);
    expect(certificationGaps(valid(doc([recite], { exam: {} })))).toEqual([]);
  });
});

describe("exam answers are stripped", () => {
  it("drops correct, why and explanation but says whether to pick several", () => {
    const view = examStepView(valid(doc([choice])).units[0].lessons[0].steps[0], "s");
    expect(view).toEqual({ type: "choice", prompt: "Pick one", choices: [{ text: "Right" }, { text: "Wrong" }], multi: false });
  });

  it("blanks the answers out and hands a word bank over as tiles", () => {
    const view = examStepView(lessonOf(valid(doc([blank]))).steps[0], "s") as { text: string; tiles: string[] };
    expect(view.text).toBe("The [[ ]] takes the [[ ]].");
    expect([...view.tiles].sort()).toEqual(["collector", "hit", "warehouse"]);
    expect(JSON.stringify(view)).not.toContain("the collector");
    const typed = examStepView(lessonOf(valid(doc([typedBlank]))).steps[0], "s");
    expect(typed).not.toHaveProperty("tiles");
  });

  it("shuffles order items out of the answer order, the same way every time", () => {
    const step = lessonOf(valid(doc([order]))).steps[0];
    const a = examStepView(step, "s") as { items: string[] };
    expect(a.items).not.toEqual(order.items);
    expect([...a.items].sort()).toEqual([...order.items].sort());
    expect(examStepView(step, "s")).toEqual(a);
  });

  it("drops a recital's answer", () => {
    expect(examStepView(lessonOf(valid(doc([recite]))).steps[0], "s")).toEqual({ type: "recite", prompt: recite.prompt });
  });

  it("only touches exam lessons", () => {
    const content = valid({
      units: [
        {
          title: "U",
          lessons: [
            { title: "Practice", steps: [choice] },
            { title: "Final", exam: {}, steps: [choice] },
          ],
        },
      ],
    });
    const out = withoutExamAnswers(content);
    expect(out.units[0].lessons[0]).toEqual(content.units[0].lessons[0]);
    expect(JSON.stringify(out.units[0].lessons[1])).not.toContain("correct");
    expect(out.units[0].lessons[1].exam).toEqual({ passMark: 80 });
  });
});

describe("gradeStep", () => {
  const c = valid(doc([choice, blank, typedBlank, order]));
  const [ch, bk, tb, od] = lessonOf(c).steps;

  it("grades a choice as the exact set of right indexes", () => {
    expect(gradeStep(ch, [0])).toBe(true);
    expect(gradeStep(ch, [0, 1])).toBe(false);
    expect(gradeStep(ch, [0, 0])).toBe(false);
    expect(gradeStep(ch, "0")).toBe(false);
  });

  it("grades blanks with the player's forgiveness, word banks on the first answer only", () => {
    expect(gradeStep(bk, ["Collector", "hit."])).toBe(true);
    expect(gradeStep(bk, ["the collector", "hit"])).toBe(false);
    expect(gradeStep(tb, ["  THE   collector "])).toBe(true);
    expect(gradeStep(tb, [])).toBe(false);
    expect(gradeStep(tb, [42])).toBe(false);
  });

  it("grades an order exactly", () => {
    expect(gradeStep(od, order.items)).toBe(true);
    expect(gradeStep(od, [...order.items].reverse())).toBe(false);
  });
});

describe("gradeExam", () => {
  const lesson: CourseLesson = lessonOf(
    valid(doc([{ type: "teach", body: "Read", visual: { kind: "emoji", emoji: "📘" } }, choice, recite, order], { exam: {} })),
  );

  it("scores the share of graded steps right and judges recitals", async () => {
    const judge = vi.fn().mockResolvedValue({ correct: true, score: 90, feedback: "That captures it.", judge: "ai" });
    const g = await gradeExam(lesson, [null, [0], "atomicity consistency isolation durability", ["two"]], judge);
    expect(g).toMatchObject({ score: 67, right: 2, graded: 3 });
    expect(g.steps.map((s) => s.index)).toEqual([1, 2, 3]);
    expect(g.steps[1]).toEqual({ index: 2, correct: true, feedback: "That captures it." });
    expect(judge).toHaveBeenCalledWith({
      prompt: recite.prompt,
      reference: recite.answer,
      recital: "atomicity consistency isolation durability",
    });
  });

  it("marks a missing recital wrong without asking the judge", async () => {
    const judge = vi.fn();
    const g = await gradeExam(lesson, [], judge);
    expect(g.score).toBe(0);
    expect(judge).not.toHaveBeenCalled();
  });

  it("throws when the judge does, so nothing gets recorded", async () => {
    const judge = vi.fn().mockRejectedValue(new Error("down"));
    await expect(gradeExam(lesson, [null, [0], "something"], judge)).rejects.toThrow("down");
  });
});
