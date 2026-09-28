// tests/modules/shared/word-count.test.ts — SHAN-541
//
// The point of these is the gap between a whitespace split and a reading-time
// word count. Every case below is one where `text.split(/\s+/)` gets a
// different answer, which is exactly why blog_posts.word_count cannot be
// computed in SQL.
import { describe, it, expect } from "vitest";
import { countBodyWords } from "@/modules/shared/word-count";

describe("countBodyWords", () => {
  it("counts plain prose", () => {
    expect(countBodyWords("one two three")).toBe(3);
  });

  it("returns 0 for empty, whitespace and markup-only bodies", () => {
    expect(countBodyWords("")).toBe(0);
    expect(countBodyWords("   \n\n  ")).toBe(0);
    expect(countBodyWords("```\nconst a = 1;\n```")).toBe(0);
    // 0 is load-bearing: the tile hides "min read" entirely rather than
    // floor a made-up 1 the way the old excerpt-derived number did.
    expect(countBodyWords(null as unknown as string)).toBe(0);
  });

  it("drops fenced code rather than charging reading time for it", () => {
    const body = "intro words here\n\n```js\nconst a = 1;\nconsole.log(a, b, c);\n```\n\noutro";
    expect(countBodyWords(body)).toBe(4);
  });

  it("does not count heading, list, quote or rule markers as words", () => {
    expect(countBodyWords("# Heading here")).toBe(2);
    expect(countBodyWords("- alpha\n- beta\n- gamma")).toBe(3);
    expect(countBodyWords("1. alpha\n2. beta")).toBe(2);
    expect(countBodyWords("> quoted words")).toBe(2);
    expect(countBodyWords("---\n\nafter the rule")).toBe(3);
  });

  it("counts link and image text, never the URL", () => {
    expect(countBodyWords("read [the whole thing](https://example.com/a/b) now")).toBe(5);
    expect(countBodyWords("![a real caption](https://example.com/x.png)")).toBe(3);
    // Auto-generated alt (a filename, or the editor's fallback) is not prose.
    expect(countBodyWords("![screenshot.png](https://example.com/x.png)")).toBe(0);
    expect(countBodyWords("![pasted-image](https://example.com/x.png)")).toBe(0);
  });

  it("counts the label of a data marker, not its payload", () => {
    expect(countBodyWords('[[data:trip|Europe Trip|{"id":1,"legs":9}]] after')).toBe(3);
  });

  it("unwraps inline emphasis and code without changing the count", () => {
    expect(countBodyWords("**bold words** and _em text_ and `code span` and ~~struck out~~")).toBe(
      11
    );
  });

  it("is high enough on a long body to distinguish it from a short one", () => {
    // The bug this ticket fixes: a 500-char excerpt is ~80 words, so every
    // post longer than two paragraphs reported the same 1 minute.
    const long = "word ".repeat(3400);
    expect(countBodyWords(long)).toBe(3400);
    expect(Math.ceil(countBodyWords(long) / 225)).toBe(16);
  });
});
