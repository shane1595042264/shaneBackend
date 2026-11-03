// src/modules/courses/content-schema.ts
//
// The structured format an interactive course is written in. Anyone can author
// one, by hand in the lesson editor or programmatically through
// PUT /api/courses/:id/content. Nothing here is AI: every exercise has a fixed
// answer written by the author, and grading on the client is pure comparison.
//
// Shape (version 1):
//
//   { "version": 1,
//     "units": [
//       { "id"?, "title", "summary"?,
//         "lessons": [
//           { "id"?, "title", "summary"?,
//             "steps": [ teach | choice | blank | order | match ] } ] } ] }
//
// Ids are optional on input and derived from titles. The normalised document
// that comes back always carries them, and learner progress is keyed by lesson
// id, so keep them stable once a course is live.
//
// The public reference for this format lives in shaneFrontend
// apps/shell/lib/docs/content/courses-api.ts. Change one, change the other.

import { z } from "zod";
import { dropLoneSurrogates } from "@/modules/shared/validators";

export const CONTENT_VERSION = 1;
export const MAX_CONTENT_BYTES = 512 * 1024;

const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const BLANK_RE = /\[\[([^\[\]]+)\]\]/g;

// SHAN-578: a lone surrogate half makes the jsonb insert throw, so scrub every
// string on the way in rather than 500 on a pasted emoji fragment.
const text = (max: number) =>
  z
    .string()
    .transform((s) => dropLoneSurrogates(s).trim())
    .pipe(z.string().min(1, "Must not be empty").max(max, `At most ${max} characters`));

const optionalText = (max: number) =>
  z
    .string()
    .optional()
    .transform((s) => (s === undefined ? undefined : dropLoneSurrogates(s).trim() || undefined))
    .pipe(z.string().max(max, `At most ${max} characters`).optional());

// Code keeps its indentation: only trailing whitespace is dropped.
const optionalCode = z
  .string()
  .optional()
  .transform((s) => (s === undefined ? undefined : dropLoneSurrogates(s).replace(/\s+$/, "") || undefined))
  .pipe(z.string().max(4000, "At most 4000 characters").optional());

const id = z
  .string()
  .trim()
  .regex(ID_RE, "Lowercase letters, digits and hyphens, starting with a letter or digit, at most 64")
  .optional();

// Every graded step may carry a code snippet (the "what does this print?"
// shape) and an explanation shown after the learner answers.
const gradedExtras = {
  code: optionalCode,
  language: optionalText(30),
  explanation: optionalText(1500),
};

const teachStep = z
  .object({
    type: z.literal("teach"),
    title: optionalText(200),
    body: text(4000),
    code: optionalCode,
    language: optionalText(30),
  })
  .strict();

const choiceStep = z
  .object({
    type: z.literal("choice"),
    prompt: text(1000),
    choices: z
      .array(
        z
          .object({
            text: text(300),
            correct: z.boolean().optional(),
            why: optionalText(1000),
          })
          .strict(),
      )
      .min(2, "A choice step needs at least 2 choices")
      .max(8, "A choice step takes at most 8 choices"),
    ...gradedExtras,
  })
  .strict();

function refineChoice(s: z.infer<typeof choiceStep>, ctx: z.RefinementCtx) {
    if (!s.choices.some((c) => c.correct)) {
      ctx.addIssue({
        code: "custom",
        path: ["choices"],
        message: 'Mark at least one choice "correct": true',
      });
    }
    const seen = new Set<string>();
    s.choices.forEach((c, i) => {
      const k = c.text.toLowerCase();
      if (seen.has(k)) ctx.addIssue({ code: "custom", path: ["choices", i, "text"], message: "Duplicate choice" });
      seen.add(k);
    });
}

const blankStep = z
  .object({
    type: z.literal("blank"),
    prompt: optionalText(1000),
    // "The pixel sends each hit to the [[collector|the collector]]."
    text: text(2000),
    // Present = word-bank mode: these distractors are mixed in with each
    // blank's first answer as tiles to tap. Absent = the learner types.
    bank: z.array(text(80)).max(12, "At most 12 distractors").optional(),
    ...gradedExtras,
  })
  .strict();

function refineBlank(s: z.infer<typeof blankStep>, ctx: z.RefinementCtx) {
    const blanks = parseBlanks(s.text);
    if (blanks.length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["text"],
        message: "Mark at least one blank as [[answer]] (alternatives as [[answer|other]])",
      });
    }
    if (blanks.length > 10) {
      ctx.addIssue({ code: "custom", path: ["text"], message: "At most 10 blanks" });
    }
    blanks.forEach((answers, i) => {
      if (answers.length === 0) {
        ctx.addIssue({ code: "custom", path: ["text"], message: `Blank ${i + 1} has no answer` });
      }
      if (answers.some((a) => a.length > 80)) {
        ctx.addIssue({ code: "custom", path: ["text"], message: `Blank ${i + 1}: answers are at most 80 characters` });
      }
    });
    if (s.bank) {
      const answers = new Set(blanks.map((a) => (a[0] ?? "").toLowerCase()));
      s.bank.forEach((d, i) => {
        if (answers.has(d.toLowerCase())) {
          ctx.addIssue({
            code: "custom",
            path: ["bank", i],
            message: "A distractor cannot also be an answer",
          });
        }
      });
    }
}

const orderStep = z
  .object({
    type: z.literal("order"),
    prompt: text(1000),
    // Written in the correct order; the player shuffles them.
    items: z
      .array(text(200))
      .min(2, "An order step needs at least 2 items")
      .max(10, "An order step takes at most 10 items"),
    ...gradedExtras,
  })
  .strict();

function refineOrder(s: z.infer<typeof orderStep>, ctx: z.RefinementCtx) {
    const seen = new Set<string>();
    s.items.forEach((it, i) => {
      const k = it.toLowerCase();
      if (seen.has(k)) ctx.addIssue({ code: "custom", path: ["items", i], message: "Duplicate item" });
      seen.add(k);
    });
}

const matchStep = z
  .object({
    type: z.literal("match"),
    prompt: optionalText(1000),
    pairs: z
      .array(z.tuple([text(120), text(120)]))
      .min(2, "A match step needs at least 2 pairs")
      .max(8, "A match step takes at most 8 pairs"),
    ...gradedExtras,
  })
  .strict();

function refineMatch(s: z.infer<typeof matchStep>, ctx: z.RefinementCtx) {
    for (const side of [0, 1] as const) {
      const seen = new Set<string>();
      s.pairs.forEach((p, i) => {
        const k = p[side].toLowerCase();
        if (seen.has(k)) {
          ctx.addIssue({
            code: "custom",
            path: ["pairs", i, side],
            message: `Duplicate ${side === 0 ? "left" : "right"} side`,
          });
        }
        seen.add(k);
      });
    }
}

// zod v3 only accepts plain objects in a discriminated union, so the per-type
// rules run on the union rather than on each member.
const step = z
  .discriminatedUnion("type", [teachStep, choiceStep, blankStep, orderStep, matchStep], {
    errorMap: (issue, ctx) =>
      issue.code === "invalid_union_discriminator"
        ? { message: 'type must be one of "teach", "choice", "blank", "order", "match"' }
        : { message: ctx.defaultError },
  })
  .superRefine((s, ctx) => {
    if (s.type === "choice") refineChoice(s, ctx);
    else if (s.type === "blank") refineBlank(s, ctx);
    else if (s.type === "order") refineOrder(s, ctx);
    else if (s.type === "match") refineMatch(s, ctx);
  });

const lesson = z
  .object({
    id,
    title: text(120),
    summary: optionalText(300),
    steps: z.array(step).min(1, "A lesson needs at least one step").max(40, "A lesson takes at most 40 steps"),
  })
  .strict()
  .superRefine((l, ctx) => {
    if (!l.steps.some((s) => s.type !== "teach")) {
      ctx.addIssue({
        code: "custom",
        path: ["steps"],
        message: "A lesson needs at least one exercise (choice, blank, order or match)",
      });
    }
  });

const unit = z
  .object({
    id,
    title: text(120),
    summary: optionalText(500),
    lessons: z.array(lesson).min(1, "A unit needs at least one lesson").max(30, "A unit takes at most 30 lessons"),
  })
  .strict();

export const courseContentSchema = z
  .object({
    version: z.literal(CONTENT_VERSION).optional(),
    units: z.array(unit).min(1, "A course needs at least one unit").max(30, "A course takes at most 30 units"),
  })
  .strict();

export type CourseContentInput = z.input<typeof courseContentSchema>;
type Parsed = z.output<typeof courseContentSchema>;
type ParsedStep = Parsed["units"][number]["lessons"][number]["steps"][number];
export type CourseStep = ParsedStep;

export interface CourseLesson {
  id: string;
  title: string;
  summary?: string;
  steps: CourseStep[];
}
export interface CourseUnit {
  id: string;
  title: string;
  summary?: string;
  lessons: CourseLesson[];
}
export interface CourseContent {
  version: typeof CONTENT_VERSION;
  units: CourseUnit[];
}

export interface ContentStats {
  units: number;
  lessons: number;
  steps: number;
  exercises: number;
  estimatedMinutes: number;
}

export interface ContentIssue {
  path: string;
  message: string;
}

/** `[[a|b]] and [[c]]` -> [["a","b"],["c"]]. Mirrored in the frontend player. */
export function parseBlanks(textValue: string): string[][] {
  const out: string[][] = [];
  for (const m of textValue.matchAll(BLANK_RE)) {
    out.push(
      m[1]
        .split("|")
        .map((a) => a.trim())
        .filter((a) => a.length > 0),
    );
  }
  return out;
}

function slugify(s: string): string {
  const base = s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 56)
    .replace(/-+$/, "");
  return base || "item";
}

function uniqueId(wanted: string, taken: Set<string>): string {
  let candidate = wanted;
  for (let n = 2; taken.has(candidate); n++) candidate = `${wanted.slice(0, 60)}-${n}`;
  taken.add(candidate);
  return candidate;
}

// "units[0].lessons[2].steps[1].choices"
function formatPath(path: (string | number)[]): string {
  return path.reduce<string>(
    (acc, part) => (typeof part === "number" ? `${acc}[${part}]` : acc ? `${acc}.${part}` : part),
    "",
  );
}

export function contentStats(content: CourseContent): ContentStats {
  let lessons = 0;
  let steps = 0;
  let exercises = 0;
  for (const u of content.units) {
    for (const l of u.lessons) {
      lessons++;
      steps += l.steps.length;
      exercises += l.steps.filter((s) => s.type !== "teach").length;
    }
  }
  // About 20s to read a card and 30s to answer an exercise.
  const teach = steps - exercises;
  const estimatedMinutes = Math.max(1, Math.round((teach * 20 + exercises * 30) / 60));
  return { units: content.units.length, lessons, steps, exercises, estimatedMinutes };
}

export type ValidationResult =
  | { ok: true; content: CourseContent; stats: ContentStats }
  | { ok: false; issues: ContentIssue[] };

/**
 * Validate and normalise an authored document: trim strings, fill in ids,
 * and check the rules zod cannot express per field (ids unique across the
 * course, at most 200 lessons). Issues carry a dotted path into the document
 * so the editor and API callers can point at the exact field.
 */
export function validateCourseContent(input: unknown): ValidationResult {
  const size = Buffer.byteLength(JSON.stringify(input ?? null), "utf8");
  if (size > MAX_CONTENT_BYTES) {
    return {
      ok: false,
      issues: [{ path: "", message: `The document is ${Math.round(size / 1024)} KB; the limit is 512 KB` }],
    };
  }
  const parsed = courseContentSchema.safeParse(input);
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 50).map((i) => ({
      path: formatPath(i.path),
      message: i.message,
    }));
    return { ok: false, issues };
  }

  const issues: ContentIssue[] = [];
  const unitIds = new Set<string>();
  const lessonIds = new Set<string>();
  // Explicit ids claim their names first so a derived id never steals one.
  parsed.data.units.forEach((u, ui) => {
    if (u.id) {
      if (unitIds.has(u.id)) issues.push({ path: `units[${ui}].id`, message: `Unit id "${u.id}" is used twice` });
      unitIds.add(u.id);
    }
    u.lessons.forEach((l, li) => {
      if (!l.id) return;
      if (lessonIds.has(l.id)) {
        issues.push({ path: `units[${ui}].lessons[${li}].id`, message: `Lesson id "${l.id}" is used twice` });
      }
      lessonIds.add(l.id);
    });
  });
  if (issues.length) return { ok: false, issues };

  const content: CourseContent = {
    version: CONTENT_VERSION,
    units: parsed.data.units.map((u) => ({
      id: u.id ?? uniqueId(slugify(u.title), unitIds),
      title: u.title,
      ...(u.summary ? { summary: u.summary } : {}),
      lessons: u.lessons.map((l) => ({
        id: l.id ?? uniqueId(slugify(l.title), lessonIds),
        title: l.title,
        ...(l.summary ? { summary: l.summary } : {}),
        steps: l.steps,
      })),
    })),
  };
  const stats = contentStats(content);
  if (stats.lessons > 200) {
    return { ok: false, issues: [{ path: "units", message: "A course takes at most 200 lessons in total" }] };
  }
  return { ok: true, content, stats };
}

export function findLesson(content: CourseContent, lessonId: string): CourseLesson | null {
  for (const u of content.units) {
    for (const l of u.lessons) if (l.id === lessonId) return l;
  }
  return null;
}
