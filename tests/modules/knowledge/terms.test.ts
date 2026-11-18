import { describe, it, expect } from "vitest";
import {
  buildTermIndex,
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
    ]);
    expect(terms).toEqual([]);
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
