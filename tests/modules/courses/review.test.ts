// tests/modules/courses/review.test.ts
// SHAN-723: the certification reviewer and the runner that applies its verdict.
import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({
  generateText: vi.fn(),
  getReview: vi.fn(),
  markAttempt: vi.fn(),
  finishReview: vi.fn(),
  stalePendingReviews: vi.fn(),
  getCourseById: vi.fn(),
  getContent: vi.fn(),
  setCertified: vi.fn(),
}));

vi.mock("@/modules/shared/llm", () => ({ generateText: m.generateText }));
vi.mock("@/modules/courses/review-repo", () => ({
  getReview: m.getReview,
  markAttempt: m.markAttempt,
  finishReview: m.finishReview,
  stalePendingReviews: m.stalePendingReviews,
}));
vi.mock("@/modules/courses/repo", () => ({ getCourseById: m.getCourseById }));
vi.mock("@/modules/courses/content-repo", () => ({ getContent: m.getContent }));
vi.mock("@/modules/courses/certificate-repo", () => ({ setCertified: m.setCertified }));

import {
  MAX_REVIEW_CHARS,
  cleanReviewText,
  contentHash,
  courseForReview,
  parseReview,
  reviewCourse,
} from "@/modules/courses/review";
import { retryPendingReviews, runReview } from "@/modules/courses/review-runner";
import { validateCourseContent, type CourseContent } from "@/modules/courses/content-schema";

const doc = validateCourseContent({
  units: [
    {
      title: "Residues",
      lessons: [
        {
          title: "Poles",
          steps: [
            { type: "teach", body: "A pole is where f blows up.", visual: { kind: "emoji", emoji: "🎯" } },
            { type: "choice", prompt: "Order of 1/z^2 at 0?", choices: [{ text: "1" }, { text: "2", correct: true }] },
            { type: "blank", text: "The residue is the [[coefficient of 1/z|c-1]]." },
            { type: "recite", prompt: "State the residue theorem", answer: "The integral is 2 pi i times the sum of residues" },
          ],
        },
        {
          title: "Final",
          exam: { passMark: 90 },
          steps: [{ type: "order", prompt: "Steps", items: ["Find poles", "Sum residues"] }],
        },
      ],
    },
  ],
});
if (!doc.ok) throw new Error("fixture is invalid");
const content: CourseContent = doc.content;
const meta = { title: "Contour integrals", description: "Residues in depth", difficulty: "advanced", tags: ["complex"] };

beforeEach(() => vi.clearAllMocks());

describe("courseForReview", () => {
  it("shows the reviewer every step with its answer, and marks the exam", () => {
    const { text, truncated } = courseForReview(meta, content);
    expect(truncated).toBe(false);
    expect(text).toContain("Title: Contour integrals");
    expect(text).toContain("[EXAM, pass mark 90%]");
    expect(text).toContain("(correct) 2");
    expect(text).toContain("answers: coefficient of 1/z / c-1");
    expect(text).toContain("expected answer: The integral is 2 pi i");
    expect(text).toContain("correct order: Find poles -> Sum residues");
  });

  it("cuts a huge course and says so", () => {
    const long = { ...meta, description: "x".repeat(MAX_REVIEW_CHARS + 10) };
    const { text, truncated } = courseForReview(long, content);
    expect(truncated).toBe(true);
    expect(text.length).toBe(MAX_REVIEW_CHARS);
  });
});

describe("contentHash", () => {
  it("is stable for the same document and changes with it", () => {
    expect(contentHash(content)).toBe(contentHash(structuredClone(content)));
    const edited = structuredClone(content);
    edited.units[0].title = "Poles and residues";
    expect(contentHash(edited)).not.toBe(contentHash(content));
  });
});

describe("parseReview", () => {
  it("reads an approval and drops any feedback on it", () => {
    expect(parseReview('{"approved": true, "summary": "Rigorous.", "feedback": ["nit"]}')).toEqual({
      approved: true,
      summary: "Rigorous.",
      feedback: [],
    });
  });

  it("reads a rejection out of surrounding prose, and strips em dashes", () => {
    const v = parseReview('Here: {"approved": false, "summary": "Shallow — intro only.", "feedback": ["Add branch cuts", 3, ""]}');
    expect(v).toEqual({ approved: false, summary: "Shallow, intro only.", feedback: ["Add branch cuts"] });
  });

  it("refuses a rejection with nothing to act on, and anything that is not a verdict", () => {
    expect(parseReview('{"approved": false, "summary": "No.", "feedback": []}')).toBeNull();
    expect(parseReview('{"approved": "yes"}')).toBeNull();
    expect(parseReview("not json")).toBeNull();
  });

  it("caps long text", () => {
    expect(Array.from(cleanReviewText("a".repeat(900), 500))).toHaveLength(500);
  });
});

describe("reviewCourse", () => {
  it("throws when the model gives no usable verdict, so the caller can retry", async () => {
    m.generateText.mockResolvedValue({ text: "I think it is fine", modelUsed: "groq/x" });
    await expect(reviewCourse(meta, content)).rejects.toThrow("no usable verdict");
  });
});

describe("runReview", () => {
  const course = { id: "c1", visibility: "public", certified: false, ...meta };
  const pending = { id: "r1", courseId: "c1", status: "pending", contentHash: contentHash(content) };

  beforeEach(() => {
    m.getReview.mockResolvedValue(pending);
    m.getCourseById.mockResolvedValue(course);
    m.getContent.mockResolvedValue({ content });
    m.finishReview.mockResolvedValue(true);
  });

  it("approves and certifies", async () => {
    m.generateText.mockResolvedValue({
      text: '{"approved": true, "summary": "Top 1% material.", "feedback": []}',
      modelUsed: "anthropic/claude",
    });
    await runReview("r1");
    expect(m.markAttempt).toHaveBeenCalledWith("r1");
    expect(m.finishReview).toHaveBeenCalledWith("r1", {
      status: "approved",
      summary: "Top 1% material.",
      feedback: [],
      modelUsed: "anthropic/claude",
    });
    expect(m.setCertified).toHaveBeenCalledWith("c1", true);
  });

  it("rejects with the feedback and leaves the course uncertified", async () => {
    m.generateText.mockResolvedValue({
      text: '{"approved": false, "summary": "Introductory.", "feedback": ["Add an exam on branch cuts"]}',
      modelUsed: "gemini",
    });
    await runReview("r1");
    expect(m.finishReview.mock.calls[0][1]).toMatchObject({ status: "rejected", feedback: ["Add an exam on branch cuts"] });
    expect(m.setCertified).toHaveBeenCalledWith("c1", false);
  });

  it("leaves the submission pending when every provider is down", async () => {
    m.generateText.mockRejectedValue(new Error("All LLM providers failed. ..."));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await runReview("r1");
    warn.mockRestore();
    expect(m.markAttempt).toHaveBeenCalledWith("r1");
    expect(m.finishReview).not.toHaveBeenCalled();
    expect(m.setCertified).not.toHaveBeenCalled();
  });

  it("supersedes a submission whose lessons changed before it was read", async () => {
    m.getReview.mockResolvedValue({ ...pending, contentHash: "older" });
    await runReview("r1");
    expect(m.finishReview).toHaveBeenCalledWith("r1", { status: "superseded" });
    expect(m.generateText).not.toHaveBeenCalled();
  });

  it("does not touch the course when a newer submission superseded this one mid-read", async () => {
    m.generateText.mockResolvedValue({ text: '{"approved": true, "summary": "Good.", "feedback": []}', modelUsed: "x" });
    m.finishReview.mockResolvedValue(false);
    await runReview("r1");
    expect(m.setCertified).not.toHaveBeenCalled();
  });

  it("skips a review that is no longer pending", async () => {
    m.getReview.mockResolvedValue({ ...pending, status: "approved" });
    await runReview("r1");
    expect(m.markAttempt).not.toHaveBeenCalled();
  });

  it("the sweep retries each stale pending review", async () => {
    m.stalePendingReviews.mockResolvedValue(["r1", "r2"]);
    m.getReview.mockResolvedValue({ ...pending, status: "superseded" });
    await retryPendingReviews();
    expect(m.getReview).toHaveBeenCalledTimes(2);
  });
});
