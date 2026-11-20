// src/modules/courses/exam.ts
//
// SHAN-721: exam lessons. Practice lessons are graded in the browser and only
// report a score, which is fine for practice and worthless for a certificate.
// An exam is the opposite: learners are served its steps without the answers
// (examView), they answer every step once with no feedback in between, and the
// server grades the whole sheet (gradeExam). The rules here mirror the
// player's grading in shaneFrontend lib/course-lessons.ts, so a step reads the
// same in practice and in an exam.

import { parseBlanks, type CourseContent, type CourseLesson, type CourseStep } from "./content-schema";
import type { ReciteVerdict } from "@/modules/knowledge/recite";

/**
 * Typed answers forgive case, surrounding space, runs of space, curly quotes
 * and trailing punctuation, nothing fuzzier. Mirrors normalizeAnswer in the
 * frontend player.
 */
export function normalizeAnswer(s: string): string {
  return s
    .normalize("NFKC")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.,;:!?]+$/, "")
    .trim();
}

/** A random number generator that returns the same sequence for the same seed. */
export function seededRandom(seed: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  return () => {
    h += 0x6d2b79f5;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministic, so the same exam comes back in the same order on every load. */
export function seededShuffle<T>(items: T[], seed: string): T[] {
  const rand = seededRandom(seed);
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  // A shuffle that lands in the answer order gives the answer away; rotate it.
  if (out.length > 1 && out.every((v, i) => v === items[i])) out.push(out.shift() as T);
  return out;
}

const BLANK_RE = /\[\[([^\[\]]+)\]\]/g;

/**
 * One exam step as a learner receives it: everything needed to answer and
 * nothing that grades. Choices keep their order (answers are indexes into it)
 * but lose `correct` and `why`; blanks lose their answers, and a word bank
 * arrives as finished tiles; order items arrive shuffled; a recital loses its
 * answer. Explanations are dropped everywhere, since they tend to restate the
 * answer.
 */
export function examStepView(step: CourseStep, seed: string): Record<string, unknown> {
  const extras = {
    ...(step.code ? { code: step.code } : {}),
    ...(step.language ? { language: step.language } : {}),
  };
  switch (step.type) {
    case "teach":
      return step;
    case "choice":
      return {
        type: "choice",
        prompt: step.prompt,
        choices: step.choices.map((c) => ({ text: c.text })),
        multi: step.choices.filter((c) => c.correct).length > 1,
        ...extras,
      };
    case "blank": {
      const firsts = parseBlanks(step.text).map((a) => a[0] ?? "");
      return {
        type: "blank",
        ...(step.prompt ? { prompt: step.prompt } : {}),
        text: step.text.replace(BLANK_RE, "[[ ]]"),
        ...(step.bank ? { tiles: seededShuffle([...firsts, ...step.bank], `${seed}:tiles`) } : {}),
        ...extras,
      };
    }
    case "order":
      return { type: "order", prompt: step.prompt, items: seededShuffle(step.items, `${seed}:items`), ...extras };
    case "recite":
      return { type: "recite", prompt: step.prompt, ...extras };
    case "match":
      // The validator keeps match out of exams; a stored one is served as is.
      return step;
  }
}

/** The document with every exam lesson's answers taken out. */
export function withoutExamAnswers(content: CourseContent): CourseContent {
  return {
    ...content,
    units: content.units.map((u) => ({
      ...u,
      lessons: u.lessons.map((l) =>
        l.exam
          ? ({ ...l, steps: l.steps.map((s, i) => examStepView(s, `${l.id}:${i}`)) } as CourseLesson)
          : l,
      ),
    })),
  };
}

function isStringArray(v: unknown, max: number): v is string[] {
  return Array.isArray(v) && v.length <= max && v.every((x) => typeof x === "string" && x.length <= 2000);
}

/** Whether one non-recite answer is right. A malformed answer is simply wrong. */
export function gradeStep(step: CourseStep, answer: unknown): boolean {
  switch (step.type) {
    case "choice": {
      if (!Array.isArray(answer) || !answer.every((i) => Number.isInteger(i))) return false;
      const picked = new Set(answer as number[]);
      const right = step.choices.flatMap((c, i) => (c.correct ? [i] : []));
      return picked.size === answer.length && right.length === picked.size && right.every((i) => picked.has(i));
    }
    case "blank": {
      const blanks = parseBlanks(step.text);
      if (!isStringArray(answer, blanks.length) || answer.length !== blanks.length) return false;
      return blanks.every((answers, i) => {
        const got = normalizeAnswer(answer[i]);
        if (!got) return false;
        // A word bank offers only the first answer as a tile.
        const accepted = step.bank ? answers.slice(0, 1) : answers;
        return accepted.some((a) => normalizeAnswer(a) === got);
      });
    }
    case "order":
      return (
        isStringArray(answer, step.items.length) &&
        answer.length === step.items.length &&
        answer.every((v, i) => v === step.items[i])
      );
    default:
      return false;
  }
}

export interface ExamStepResult {
  index: number;
  correct: boolean;
  /** A recital's one-line feedback; never contains the answer. */
  feedback?: string;
}

export interface ExamGrade {
  score: number;
  right: number;
  graded: number;
  steps: ExamStepResult[];
}

type Judge = (input: { prompt: string; reference: string; recital: string }) => Promise<ReciteVerdict>;

/**
 * Grade a whole exam sheet. `answers[i]` answers step i (teach steps take
 * anything). Recitals are judged in parallel by `judge`; if it throws, the
 * whole grade throws, so a provider outage never records a failed exam.
 */
export async function gradeExam(lesson: CourseLesson, answers: unknown[], judge: Judge): Promise<ExamGrade> {
  const steps = await Promise.all(
    lesson.steps.map(async (step, index): Promise<ExamStepResult | null> => {
      if (step.type === "teach") return null;
      const answer = answers[index];
      if (step.type !== "recite") return { index, correct: gradeStep(step, answer) };
      const recital = typeof answer === "string" ? answer.trim().slice(0, 5000) : "";
      if (!recital) return { index, correct: false, feedback: "No answer given." };
      const verdict = await judge({ prompt: step.prompt, reference: step.answer, recital });
      return { index, correct: verdict.correct, feedback: verdict.feedback };
    }),
  );
  const graded = steps.filter((s): s is ExamStepResult => s !== null);
  const right = graded.filter((s) => s.correct).length;
  return {
    score: graded.length === 0 ? 0 : Math.round((100 * right) / graded.length),
    right,
    graded: graded.length,
    steps: graded,
  };
}
