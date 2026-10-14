import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockSmall, mockEmbed } = vi.hoisted(() => ({
  mockSmall: vi.fn(),
  mockEmbed: vi.fn(),
}));

vi.mock("@/modules/shared/llm", () => ({ generateSmallText: mockSmall }));
vi.mock("@/modules/shared/embeddings", () => ({ embed: mockEmbed }));

import {
  buildHints,
  cleanFeedback,
  cosine,
  feedbackLeaks,
  isNearVerbatim,
  judgeRecital,
  normalizeRecital,
  parseVerdict,
  shapeOf,
} from "@/modules/knowledge/recite";

const DMESG =
  "A command on Unix-like operating systems that prints or controls the kernel ring buffer, standing for 'display message' or 'driver message'.";

beforeEach(() => vi.clearAllMocks());

describe("normalizeRecital / isNearVerbatim", () => {
  it("ignores case, punctuation and spacing", () => {
    expect(normalizeRecital("  Hello,   World!! ")).toBe("hello world");
    expect(isNearVerbatim("a command on unix like operating systems that prints or controls the kernel ring buffer standing for display message or driver message", DMESG)).toBe(true);
  });

  it("allows a typo but not a different sentence", () => {
    expect(isNearVerbatim(DMESG.replace("kernel", "kernal"), DMESG)).toBe(true);
    expect(isNearVerbatim("unix command that prints the kernel ring buffer", DMESG)).toBe(false);
  });

  it("never matches an empty side", () => {
    expect(isNearVerbatim("", DMESG)).toBe(false);
    expect(isNearVerbatim("!!!", "")).toBe(false);
  });
});

describe("parseVerdict / cleanFeedback", () => {
  it("reads a JSON verdict, even wrapped in prose", () => {
    expect(parseVerdict('Sure: {"correct": true, "score": 91.6, "feedback": "Nice."}')).toEqual({
      correct: true,
      score: 92,
      feedback: "Nice.",
    });
  });

  it("rejects anything without a boolean verdict", () => {
    expect(parseVerdict("no json here")).toBeNull();
    expect(parseVerdict('{"correct": "yes"}')).toBeNull();
    expect(parseVerdict("{broken")).toBeNull();
  });

  it("clamps the score and fills a missing one from the verdict", () => {
    expect(parseVerdict('{"correct": false, "score": 400, "feedback": "x"}')?.score).toBe(100);
    expect(parseVerdict('{"correct": false, "feedback": "x"}')?.score).toBe(0);
  });

  it("supplies feedback when the model gave none", () => {
    expect(parseVerdict('{"correct": false, "score": 10}')?.feedback).toBe("Not quite yet. Try again.");
  });

  it("strips em and en dashes and caps the length", () => {
    expect(cleanFeedback("Great job—your recital works – nice")).toBe("Great job, your recital works, nice");
    expect(Array.from(cleanFeedback("a".repeat(500))).length).toBe(220);
  });
});

describe("feedbackLeaks", () => {
  it("flags feedback that names reference content the learner did not type", () => {
    expect(feedbackLeaks("It does not mention the kernel ring buffer.", DMESG, "it shows disk usage in linux")).toBe(true);
  });

  it("allows feedback about the size of the gap", () => {
    expect(feedbackLeaks("You left out what it does and its name.", DMESG, "linux command")).toBe(false);
  });

  it("allows echoing words the learner already typed", () => {
    expect(feedbackLeaks("Your kernel buffer part is right.", DMESG, "prints the kernel ring buffer")).toBe(false);
  });
});

describe("hints", () => {
  it("goes example, opening words, then shape", () => {
    const hints = buildHints({ definition: DMESG, exampleSentence: "dmesg | grep -i error", labels: ["linux"] });
    expect(hints.map((h) => h.kind)).toEqual(["example", "opening", "shape"]);
    expect(hints[1].text).toBe("A command on Unix-like operating systems that ...");
    expect(hints[1].text.length).toBeLessThan(DMESG.length);
  });

  it("uses topics when there is no example", () => {
    const hints = buildHints({ definition: DMESG, exampleSentence: null, labels: ["linux", "cli", 4, "kernel", "x", "y"] });
    expect(hints[0]).toEqual({ kind: "topics", label: "Topics", text: "linux, cli, kernel, x" });
  });

  it("passes over an example that contains the answer", () => {
    const hints = buildHints({ definition: "thank you", exampleSentence: "Gracias means thank you.", labels: ["spanish"] });
    expect(hints[0].kind).toBe("topics");
  });

  it("never offers the opening words of a short answer, which would be the answer", () => {
    const hints = buildHints({ definition: "test", exampleSentence: "La prueba es dificil.", labels: [] });
    expect(hints.map((h) => h.kind)).toEqual(["example", "shape"]);
    expect(hints[1].text).toBe("t___");
  });

  it("returns nothing for a card with no definition", () => {
    expect(buildHints({ definition: "  ", exampleSentence: "x" })).toEqual([]);
  });

  it("masks every letter after the first in each word and keeps punctuation", () => {
    expect(shapeOf("Unix-like, 'display' 42x")).toBe("U___-____, 'd______' 4__");
  });
});

describe("judgeRecital", () => {
  it("passes a near-verbatim recital without calling a model", async () => {
    const v = await judgeRecital({ prompt: "dmesg", reference: DMESG, recital: DMESG.toLowerCase() });
    expect(v).toMatchObject({ correct: true, judge: "match" });
    expect(mockSmall).not.toHaveBeenCalled();
  });

  it("asks the small chain for JSON at low reasoning effort", async () => {
    mockSmall.mockResolvedValue({ text: '{"correct": true, "score": 90, "feedback": "Got it."}', modelUsed: "g" });
    const v = await judgeRecital({ prompt: "dmesg", reference: DMESG, recital: "prints the kernel ring buffer" });
    expect(v).toEqual({ correct: true, score: 90, feedback: "Got it.", judge: "ai" });
    expect(mockSmall).toHaveBeenCalledWith(expect.objectContaining({ json: true, reasoningEffort: "low" }));
    expect(mockSmall.mock.calls[0][0].prompt).toContain("<<<prints the kernel ring buffer>>>");
  });

  it("replaces miss feedback that gives the answer away", async () => {
    mockSmall.mockResolvedValue({
      text: '{"correct": false, "score": 5, "feedback": "It is about the kernel ring buffer."}',
      modelUsed: "g",
    });
    const v = await judgeRecital({ prompt: "dmesg", reference: DMESG, recital: "shows disk usage" });
    expect(v.correct).toBe(false);
    expect(v.feedback).not.toMatch(/kernel|ring|buffer/i);
  });

  it("falls back to embedding similarity when every provider fails", async () => {
    mockSmall.mockRejectedValue(new Error("Small LLM chain failed: down"));
    mockEmbed.mockResolvedValueOnce([1, 0]).mockResolvedValueOnce([0.9, 0.1]);
    const v = await judgeRecital({ prompt: "dmesg", reference: DMESG, recital: "kernel log printer" });
    expect(v).toMatchObject({ correct: true, judge: "similarity" });
  });

  it("falls back the same way on an unusable model answer", async () => {
    mockSmall.mockResolvedValue({ text: "I think so!", modelUsed: "g" });
    mockEmbed.mockResolvedValueOnce([1, 0]).mockResolvedValueOnce([0, 1]);
    const v = await judgeRecital({ prompt: "dmesg", reference: DMESG, recital: "something else" });
    expect(v).toMatchObject({ correct: false, judge: "similarity", score: 0 });
  });

  it("throws when the local model fails too", async () => {
    mockSmall.mockRejectedValue(new Error("down"));
    mockEmbed.mockRejectedValue(new Error("no model"));
    await expect(judgeRecital({ prompt: "x", reference: DMESG, recital: "y" })).rejects.toThrow("no model");
  });
});

describe("cosine", () => {
  it("is 1 for parallel vectors and 0 for orthogonal or empty ones", () => {
    expect(cosine([2, 0], [5, 0])).toBeCloseTo(1);
    expect(cosine([1, 0], [0, 1])).toBe(0);
    expect(cosine([], [])).toBe(0);
  });
});
