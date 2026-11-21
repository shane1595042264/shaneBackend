// tests/modules/courses/content-schema.test.ts
import { describe, it, expect } from "vitest";
import {
  findLesson,
  parseBlanks,
  validateCourseContent,
  type CourseContent,
} from "@/modules/courses/content-schema";

const choice = {
  type: "choice",
  prompt: "Pick one",
  choices: [{ text: "Right", correct: true }, { text: "Wrong" }],
};

function doc(steps: unknown[], extra: Record<string, unknown> = {}) {
  return { units: [{ title: "Unit", lessons: [{ title: "Lesson", steps, ...extra }] }] };
}

function issues(input: unknown) {
  const r = validateCourseContent(input);
  if (r.ok) throw new Error("expected invalid");
  return r.issues;
}

function valid(input: unknown): CourseContent {
  const r = validateCourseContent(input);
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.content;
}

describe("parseBlanks", () => {
  it("splits alternatives and trims them", () => {
    expect(parseBlanks("To the [[collector | the collector]] then [[BigQuery]].")).toEqual([
      ["collector", "the collector"],
      ["BigQuery"],
    ]);
  });

  it("finds nothing in plain text", () => {
    expect(parseBlanks("no blanks [here]")).toEqual([]);
  });
});

describe("validateCourseContent", () => {
  it("derives ids from titles and de-duplicates them", () => {
    const c = valid({
      units: [
        {
          title: "Where it goes!",
          lessons: [
            { title: "Ten Stops", steps: [choice] },
            { title: "Ten stops", steps: [choice] },
          ],
        },
      ],
    });
    expect(c.version).toBe(1);
    expect(c.units[0].id).toBe("where-it-goes");
    expect(c.units[0].lessons.map((l) => l.id)).toEqual(["ten-stops", "ten-stops-2"]);
  });

  it("never lets a derived id steal an explicit one", () => {
    const c = valid({
      units: [
        {
          title: "U",
          lessons: [
            { title: "Intro", steps: [choice] },
            { id: "intro", title: "Something else", steps: [choice] },
          ],
        },
      ],
    });
    expect(c.units[0].lessons.map((l) => l.id)).toEqual(["intro-2", "intro"]);
  });

  it("rejects an explicit lesson id used twice across units", () => {
    const lesson = { id: "same", title: "L", steps: [choice] };
    const found = issues({ units: [{ title: "A", lessons: [lesson] }, { title: "B", lessons: [lesson] }] });
    expect(found[0]).toEqual({ path: "units[1].lessons[0].id", message: 'Lesson id "same" is used twice' });
  });

  it("rejects an id with uppercase or spaces", () => {
    expect(issues(doc([choice], { id: "Ten Stops" }))[0].path).toBe("units[0].lessons[0].id");
  });

  it("requires at least one exercise per lesson", () => {
    expect(issues(doc([{ type: "teach", body: "Read me", visual: { kind: "emoji", emoji: "📘" } }]))[0].message).toMatch(/at least one exercise/);
  });

  it("rejects unknown step types and unknown keys", () => {
    const found = issues(doc([choice, { type: "essay", prompt: "x" }, { ...choice, answer: 0 }]));
    expect(found.map((i) => i.path)).toEqual([
      "units[0].lessons[0].steps[1].type",
      "units[0].lessons[0].steps[2]",
    ]);
  });

  it("requires a correct choice", () => {
    const found = issues(doc([{ ...choice, choices: [{ text: "a" }, { text: "b" }] }]));
    expect(found[0].path).toBe("units[0].lessons[0].steps[0].choices");
  });

  it("allows several correct choices (select all that apply)", () => {
    valid(doc([{ ...choice, choices: [{ text: "a", correct: true }, { text: "b", correct: true }, { text: "c" }] }]));
  });

  it("requires a blank marker and keeps distractors distinct from answers", () => {
    expect(issues(doc([{ type: "blank", text: "No markers here." }]))[0].path).toBe(
      "units[0].lessons[0].steps[0].text",
    );
    const found = issues(doc([{ type: "blank", text: "Hits go to [[Bronze]].", bank: ["Silver", "bronze"] }]));
    expect(found[0].path).toBe("units[0].lessons[0].steps[0].bank[1]");
  });

  it("compares distractors the way answers are graded (SHAN-728)", () => {
    const bank = (text: string, b: string[]) => issues(doc([{ type: "blank", text, bank: b }]));
    // Trailing punctuation and spacing are forgiven when grading, so these grade right.
    expect(bank("Capital: [[Paris]].", ["Rome", "Paris."])[0]).toMatchObject({
      path: "units[0].lessons[0].steps[0].bank[1]",
      message: "A distractor cannot also be an answer",
    });
    expect(bank("Capital: [[New York]].", ["new  york"])[0].path).toBe("units[0].lessons[0].steps[0].bank[0]");
    // A listed alternative reads as an answer but grades wrong as a tile.
    expect(bank("Hits go to [[collector|the collector]].", ["the collector"])[0].path).toBe(
      "units[0].lessons[0].steps[0].bank[0]",
    );
    expect(bank("Hits go to [[Bronze]].", ["Gold", "gold!"])[0]).toMatchObject({
      path: "units[0].lessons[0].steps[0].bank[1]",
      message: "Duplicate distractor",
    });
    valid(doc([{ type: "blank", text: "Hits go to [[Bronze]].", bank: ["Gold", "Silver"] }]));
  });

  it("rejects duplicate order items and duplicate match sides", () => {
    expect(issues(doc([{ type: "order", prompt: "Order", items: ["a", "A"] }]))[0].path).toBe(
      "units[0].lessons[0].steps[0].items[1]",
    );
    expect(issues(doc([{ type: "match", pairs: [["a", "1"], ["b", "1"]] }]))[0].path).toBe(
      "units[0].lessons[0].steps[0].pairs[1][1]",
    );
  });

  it("trims prose but keeps code indentation", () => {
    const c = valid(doc([{ ...choice, prompt: "  What prints?  ", code: "  if x:\n    print(1)\n\n" }]));
    const step = c.units[0].lessons[0].steps[0];
    expect(step.type === "choice" && step.prompt).toBe("What prints?");
    expect(step.type === "choice" && step.code).toBe("  if x:\n    print(1)");
  });

  it("drops lone surrogate halves so the jsonb insert cannot throw", () => {
    const c = valid(doc([{ ...choice, prompt: "Half \ud83d an emoji" }]));
    const step = c.units[0].lessons[0].steps[0];
    expect(step.type === "choice" && step.prompt).toBe("Half  an emoji");
  });

  it("refuses a document over 512 KB", () => {
    const big = doc([{ type: "teach", body: "x".repeat(4000), visual: { kind: "emoji", emoji: "📘" } }, choice]);
    const units = Array.from({ length: 30 }, (_, i) => ({
      title: `U${i}`,
      lessons: Array.from({ length: 6 }, (_, j) => ({ title: `L${j}`, steps: big.units[0].lessons[0].steps })),
    }));
    expect(issues({ units })[0].message).toMatch(/limit is 512 KB/);
  });

  it("estimates minutes from teach cards and exercises", () => {
    const r = validateCourseContent(doc([{ type: "teach", body: "a", visual: { kind: "emoji", emoji: "📘" } }, choice, choice, choice]));
    expect(r.ok && r.stats).toEqual({ units: 1, lessons: 1, steps: 4, exercises: 3, estimatedMinutes: 2 });
  });
});

describe("teach visuals (SHAN-713)", () => {
  const teach = (visual?: unknown) => ({ type: "teach", body: "One idea.", ...(visual === undefined ? {} : { visual }) });
  const IMG = "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b";

  it("refuses a teach card with no visual, and says what would do", () => {
    const [issue] = issues(doc([teach(), choice]));
    expect(issue.path).toBe("units[0].lessons[0].steps[0].visual");
    expect(issue.message).toMatch(/Every teach card needs a visual/);
    expect(issue.message).toMatch(/emoji/);
  });

  it("accepts each kind, emoji being the floor", () => {
    for (const v of [
      { kind: "emoji", emoji: "🧭" },
      { kind: "emoji", emoji: "👩‍💻", caption: "You, at the keyboard" },
      { kind: "diagram", mermaid: "flowchart LR\n  A --> B" },
      { kind: "diagram", mermaid: "%% the trip\nsequenceDiagram\n  A->>B: hi" },
      { kind: "image", src: `/api/journal/images/${IMG}`, alt: "The collector" },
    ]) {
      expect(() => valid(doc([teach(v), choice])), JSON.stringify(v)).not.toThrow();
    }
  });

  it("keeps an absolute link to the site's image store as a relative path", () => {
    for (const host of ["https://shanejli.com", "https://shanebackend-production.up.railway.app"]) {
      const c = valid(doc([teach({ kind: "image", src: `${host}/api/journal/images/${IMG.toUpperCase()}`, alt: "x" }), choice]));
      const step = c.units[0].lessons[0].steps[0];
      expect(step.type === "teach" && step.visual).toEqual({ kind: "image", src: `/api/journal/images/${IMG}`, alt: "x" });
    }
  });

  it.each([
    ["an outside image", { kind: "image", src: "https://example.com/pixel.png", alt: "x" }, /Upload the image/],
    ["an image with no alt text", { kind: "image", src: `/api/journal/images/${IMG}` }, /Required|empty/],
    ["prose as a diagram", { kind: "diagram", mermaid: "The pixel sends a hit to the collector." }, /Mermaid source/],
    ["words as an emoji", { kind: "emoji", emoji: "idea" }, /Emoji only/],
    ["an emoji with words", { kind: "emoji", emoji: "💡 idea" }, /Emoji only/],
    ["an unknown kind", { kind: "video", url: "x" }, /visual.kind must be/],
    ["an unknown key", { kind: "emoji", emoji: "💡", size: 9 }, /Unrecognized key/],
  ])("refuses %s", (_label, v, message) => {
    const [issue] = issues(doc([teach(v), choice]));
    expect(issue.path.startsWith("units[0].lessons[0].steps[0].visual")).toBe(true);
    expect(issue.message).toMatch(message);
  });
});

describe("findLesson", () => {
  it("finds a lesson by id in any unit", () => {
    const c = valid({
      units: [
        { title: "A", lessons: [{ id: "one", title: "One", steps: [choice] }] },
        { title: "B", lessons: [{ id: "two", title: "Two", steps: [choice] }] },
      ],
    });
    expect(findLesson(c, "two")?.title).toBe("Two");
    expect(findLesson(c, "three")).toBeNull();
  });
});
