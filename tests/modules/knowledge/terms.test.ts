import { describe, it, expect } from "vitest";
import {
  buildTermIndex,
  onlyLinks,
  shortDefinition,
  termMatches,
  MAX_DEFINITION,
  type TermSource,
} from "@/modules/knowledge/terms";

// SHAN-712. The words below are real card words from prod, messy ones included.

describe("termMatches", () => {
  it("keeps a clean word as is", () => {
    expect(termMatches("ephemeral")).toEqual(["ephemeral"]);
    expect(termMatches("df -h")).toEqual(["df -h"]);
    expect(termMatches("NgRx")).toEqual(["NgRx"]);
  });

  it("matches both a phrase and its one-token short form", () => {
    expect(termMatches("Data Subject Access Request (DSAR)")).toEqual(["Data Subject Access Request", "DSAR"]);
    expect(termMatches("Status mapping (映射) in logistics systems")).toEqual([
      "Status mapping in logistics systems",
      "映射",
    ]);
  });

  it("treats a longer aside in parentheses as description, not a name", () => {
    expect(termMatches("Foundry (AHEAD business operations)")).toEqual(["Foundry"]);
  });

  it("takes the short label before a colon when the word is a whole sentence", () => {
    expect(
      termMatches("SSRF: SSRF stands for Server-Side Request Forgery, a security vulnerability where an attacker tricks")
    ).toEqual(["SSRF"]);
  });

  it("drops a leading bracket tag and anything too long to say in passing", () => {
    expect(termMatches("[Choreo] Jazz combo")).toEqual(["Jazz combo"]);
    expect(termMatches("If I ever Fall in Love end combo")).toEqual([]);
  });

  it("needs three characters, or two in a script without spaces", () => {
    expect(termMatches("TIL")).toEqual(["TIL"]);
    expect(termMatches("ab")).toEqual([]);
    expect(termMatches("附件")).toEqual(["附件"]);
    expect(termMatches("여 기")).toEqual(["여 기"]);
  });

  it("needs a letter", () => {
    expect(termMatches("1234")).toEqual([]);
  });

  // SHAN-717: prod has a vocabulary card for "your" (definition 你的).
  it("leaves out a lone everyday English word, in any case, but not a phrase that has one", () => {
    expect(termMatches("your")).toEqual([]);
    expect(termMatches("Your")).toEqual([]);
    expect(termMatches("THROUGH")).toEqual([]);
    expect(termMatches("Data Subject Access Request (which)")).toEqual(["Data Subject Access Request"]);
    expect(termMatches("your call")).toEqual(["your call"]);
    expect(termMatches("serendipity")).toEqual(["serendipity"]);
  });
});

describe("shortDefinition", () => {
  it("collapses whitespace and leaves a short one alone", () => {
    expect(shortDefinition("  A  kernel\nlog. ")).toBe("A kernel log.");
  });

  it("cuts a long one on a word and marks the cut", () => {
    const long = "word ".repeat(200);
    const out = shortDefinition(long);
    expect(out.endsWith("…")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(MAX_DEFINITION + 1);
    expect(out).not.toMatch(/\s…$/);
  });

  it("drops images and keeps a link's text", () => {
    expect(
      shortDefinition("A sum of terms. ![image.png](https://x.test/a.png) See [the proof](https://x.test/p) <img src=\"b.png\">"),
    ).toBe("A sum of terms. See the proof");
    expect(shortDefinition("![image.png](https://x.test/a.png)")).toBe("");
  });

  // SHAN-717: prod's "hotel lobby" card has the definition "na".
  it("treats a placeholder as no definition", () => {
    for (const p of ["na", "N/A", "n.a.", " TBD ", "todo", "None", "null", "-", "—", "?", "...", "…"]) {
      expect(shortDefinition(p)).toBe("");
    }
    expect(shortDefinition("NA: North America")).toBe("NA: North America");
    expect(shortDefinition("Nan")).toBe("Nan");
  });

  it("never cuts inside image or link markdown", () => {
    const out = shortDefinition(`${"word ".repeat(70)}![image.png](https://x.test/${"a".repeat(80)}.png) [more](https://x.test/m)`);
    expect(out).not.toMatch(/[[\]()]|https?:/);
  });
});

// SHAN-718: prod's dance cards "Alexander Tracing Combo" and "5 step combo".
describe("onlyLinks", () => {
  it("is true for a link alone, or the card's own word and a link", () => {
    expect(onlyLinks("https://www.youtube.com/shorts/_4uy2sROdYQ", "Alexander Tracing Combo")).toBe(true);
    expect(onlyLinks("5 step combo: https://www.instagram.com/p/C-L1HI4Os9c/", "5 step combo")).toBe(true);
    expect(onlyLinks("5 Step Combo - www.instagram.com/p/x", " 5 step  combo ")).toBe(true);
    expect(onlyLinks("https://a.test/1 https://a.test/2", "combo")).toBe(true);
  });

  it("is false when the definition says something besides the link", () => {
    expect(onlyLinks("A turn into a slide. https://www.youtube.com/shorts/x", "Alexander Tracing Combo")).toBe(false);
    expect(onlyLinks("Transport Layer Security.", "TLS")).toBe(false);
    expect(onlyLinks("", "TLS")).toBe(false);
  });
});

describe("buildTermIndex", () => {
  const row = (over: Partial<TermSource>): TermSource => ({
    id: "id",
    word: "word",
    definition: "a definition",
    category: "coding",
    language: "general",
    partOfSpeech: null,
    pronunciation: null,
    ...over,
  });

  it("gives a string two cards share to the first (newest) one, ignoring case", () => {
    const terms = buildTermIndex([
      row({ id: "new", word: "Telemetry" }),
      row({ id: "old", word: "telemetry" }),
    ]);
    expect(terms.map((t) => t.id)).toEqual(["new"]);
  });

  it("keeps an older card for the strings it still owns", () => {
    const terms = buildTermIndex([
      row({ id: "a", word: "DSAR" }),
      row({ id: "b", word: "Data Subject Access Request (DSAR)" }),
    ]);
    expect(terms).toHaveLength(2);
    expect(terms[1]).toMatchObject({ id: "b", match: ["Data Subject Access Request"] });
  });

  it("skips cards with nothing to show or nothing to match", () => {
    const terms = buildTermIndex([
      row({ id: "blank", word: "inode", definition: "   " }),
      row({ id: "none", word: "dmesg", definition: null }),
      row({ id: "long", word: "If I ever Fall in Love end combo" }),
      row({ id: "image", word: "Taylor Series", definition: "![image.png](https://x.test/a.png)" }),
      row({ id: "placeholder", word: "hotel lobby", definition: "na" }),
      row({ id: "everyday", word: "your", definition: "你的" }),
      row({ id: "link", word: "Alexander Tracing Combo", definition: "https://www.youtube.com/shorts/_4uy2sROdYQ" }),
      row({ id: "word-link", word: "5 step combo", definition: "5 step combo: https://www.instagram.com/p/C-L1HI4Os9c/" }),
    ]);
    expect(terms).toEqual([]);
  });

  it("leaves a string to an older card when the newer one has only an image", () => {
    const terms = buildTermIndex([
      row({ id: "image", word: "Taylor Series", definition: "![image.png](https://x.test/a.png)" }),
      row({ id: "text", word: "Taylor series", definition: "A function as an infinite sum of terms." }),
    ]);
    expect(terms.map((t) => t.id)).toEqual(["text"]);
  });

  it("returns the card's fields with a short definition", () => {
    const [t] = buildTermIndex([
      row({ id: "x", word: " TLS ", definition: "Transport  Layer Security.", partOfSpeech: "noun" }),
    ]);
    expect(t).toEqual({
      id: "x",
      word: "TLS",
      match: ["TLS"],
      definition: "Transport Layer Security.",
      category: "coding",
      language: "general",
      partOfSpeech: "noun",
      pronunciation: null,
    });
  });
});
