// src/modules/courses/review.ts
//
// SHAN-723: certification by review. An author submits a public course with
// lessons; a model reads the whole of it (every teach card, every exercise and
// its answer, every exam question) and answers one question, Shane's bar:
// could someone who finishes this course call themselves top 1% in its topic?
// Yes certifies the course. No rejects it with concrete changes to make.
//
// Everything here except reviewCourse() is pure: the version hash, the text
// the model reads, and what its answer is allowed to say back to the author.

import { createHash } from "node:crypto";
import { generateText } from "@/modules/shared/llm";
import type { CourseContent, CourseStep } from "./content-schema";
import { parseBlanks } from "./content-schema";

export interface ReviewVerdict {
  approved: boolean;
  /** One or two sentences on the course as a whole. */
  summary: string;
  /** What to change to be approved. Empty on approval. */
  feedback: string[];
}

/**
 * The version of a lesson document. Key order is fixed by the validator, which
 * rebuilds every document it saves, so the same course always hashes the same.
 */
export function contentHash(content: CourseContent): string {
  return createHash("sha256").update(JSON.stringify(content)).digest("hex");
}

/**
 * Past this the document is cut, and the model is told so. 200k characters is
 * about 50k tokens: inside every model in the fallback chain, and far more
 * than a course needs to show whether it is rigorous.
 */
export const MAX_REVIEW_CHARS = 200_000;

function stepText(step: CourseStep, n: number): string {
  const head = `  ${n}. [${step.type}]`;
  const extras: string[] = [];
  if ("code" in step && step.code) extras.push(`     code (${step.language ?? "text"}):\n${step.code.replace(/^/gm, "       ")}`);
  if ("explanation" in step && step.explanation) extras.push(`     explanation: ${step.explanation}`);
  let body: string;
  switch (step.type) {
    case "teach":
      body = `${head} ${step.title ? `${step.title}: ` : ""}${step.body}`;
      break;
    case "choice":
      body = `${head} ${step.prompt}\n${step.choices
        .map((c) => `     - ${c.correct ? "(correct) " : ""}${c.text}${c.why ? ` [why: ${c.why}]` : ""}`)
        .join("\n")}`;
      break;
    case "blank":
      body = `${head} ${step.prompt ? `${step.prompt} ` : ""}${step.text}\n     answers: ${parseBlanks(step.text)
        .map((a) => a.join(" / "))
        .join("; ")}`;
      break;
    case "order":
      body = `${head} ${step.prompt}\n     correct order: ${step.items.join(" -> ")}`;
      break;
    case "match":
      body = `${head} ${step.prompt ?? "Match the pairs"}\n${step.pairs.map(([a, b]) => `     ${a} = ${b}`).join("\n")}`;
      break;
    case "recite":
      body = `${head} ${step.prompt}\n     expected answer: ${step.answer}`;
      break;
  }
  return [body, ...extras].join("\n");
}

/** The whole course as the reviewer reads it, answers included. */
export function courseForReview(
  course: { title: string; description: string | null; difficulty: string; tags: string[] },
  content: CourseContent,
): { text: string; truncated: boolean } {
  const lines = [
    `Title: ${course.title}`,
    `Difficulty: ${course.difficulty}`,
    course.tags.length ? `Tags: ${course.tags.join(", ")}` : "",
    course.description ? `Description: ${course.description}` : "",
    "",
  ];
  for (const u of content.units) {
    lines.push(`UNIT: ${u.title}${u.summary ? ` (${u.summary})` : ""}`);
    for (const l of u.lessons) {
      const kind = l.exam ? ` [EXAM, pass mark ${l.exam.passMark}%]` : "";
      lines.push(` LESSON: ${l.title}${kind}${l.summary ? ` (${l.summary})` : ""}`);
      l.steps.forEach((s, i) => lines.push(stepText(s, i + 1)));
    }
    lines.push("");
  }
  const text = lines.filter((l, i, all) => l !== "" || all[i - 1] !== "").join("\n");
  if (text.length <= MAX_REVIEW_CHARS) return { text, truncated: false };
  return { text: text.slice(0, MAX_REVIEW_CHARS), truncated: true };
}

/**
 * Text that reaches the author: no em or en dashes (a house rule, and the
 * model's favourite punctuation), single spaces, capped.
 */
export function cleanReviewText(raw: string, max: number): string {
  const text = raw
    .replace(/\s*[—–]\s*/g, ", ")
    .replace(/\s+/g, " ")
    .replace(/,\s*,/g, ",")
    .trim();
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, max - 3).join("").trimEnd()}...` : text;
}

/** The model's verdict, or null when it did not return one we can act on. */
export function parseReview(raw: string): ReviewVerdict | null {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const p = parsed as { approved?: unknown; summary?: unknown; feedback?: unknown };
  if (typeof p.approved !== "boolean") return null;
  const summary = cleanReviewText(typeof p.summary === "string" ? p.summary : "", 600);
  const feedback = (Array.isArray(p.feedback) ? p.feedback : [])
    .filter((f): f is string => typeof f === "string")
    .map((f) => cleanReviewText(f, 500))
    .filter(Boolean)
    .slice(0, 12);
  // A rejection has to say what to change, or the author has nothing to act on.
  if (!p.approved && feedback.length === 0) return null;
  return {
    approved: p.approved,
    summary: summary || (p.approved ? "Approved." : "Not yet at the certificate bar."),
    feedback: p.approved ? [] : feedback,
  };
}

export const REVIEW_SYSTEM = `You are the certification reviewer for courses on shanejli.com. A certified course issues a certificate, so your bar is high and specific:

Could someone who finishes this course, passes its exams from memory and still recalls it a day later, honestly call themselves top 1% in this course's topic?

Judge the topic the course claims (its title, description and tags), not a broader field. Read everything: what the teach cards explain, whether the exercises test understanding or only recognition, whether the recite steps and exams demand real recall, and whether the stated answers are correct. Reject when the material is shallow, covers only an introduction, has factual errors, or tests trivia instead of the skills that set the top 1% apart. Approve only when finishing it would genuinely put a learner there.

Answer with JSON only, no prose around it:
{"approved": true|false, "summary": "one or two sentences on the course as a whole", "feedback": ["a concrete change", ...]}

On a rejection, feedback lists 3 to 8 specific, actionable changes that would get the course approved: name the lesson or step, the missing topic, the wrong answer, the exercise to add. On an approval, feedback is []. Write plainly; do not use em dashes.`;

/**
 * One review. Throws when every provider fails or none returns a verdict we
 * can parse: the caller leaves the submission pending and tries again later,
 * because an outage must never read as a rejection.
 */
export async function reviewCourse(
  course: { title: string; description: string | null; difficulty: string; tags: string[] },
  content: CourseContent,
): Promise<ReviewVerdict & { modelUsed: string }> {
  const { text, truncated } = courseForReview(course, content);
  const result = await generateText({
    system: REVIEW_SYSTEM,
    prompt: `${truncated ? "(The course is long; it is cut off at the end. Judge what is shown.)\n\n" : ""}${text}`,
    maxTokens: 2000,
    json: true,
  });
  const verdict = parseReview(result.text);
  if (!verdict) throw new Error(`Reviewer returned no usable verdict (${result.modelUsed})`);
  return { ...verdict, modelUsed: result.modelUsed };
}
