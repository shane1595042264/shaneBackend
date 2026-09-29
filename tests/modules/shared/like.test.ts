// SHAN-545. Two things are under test here and they fail for different
// reasons:
//
//  1. `likeContains` escapes the LIKE metacharacters. Straightforward.
//  2. No file in src/ builds a `%…%` pattern by interpolation any more.
//     That is the part that actually keeps this fixed. The escaping already
//     existed twice (blog, journal) as a copy-pasted one-liner when
//     knowledge/routes.ts and vocabulary/routes.ts were written without it,
//     and nothing failed — a half-escaped search looks correct for every term
//     that happens to contain neither `%` nor `_`. The only signal was a
//     human reading four files side by side, so this asserts it instead.
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { escapeLikeTerm, likeContains } from "@/modules/shared/like";

describe("escapeLikeTerm", () => {
  it("escapes the two LIKE metacharacters", () => {
    expect(escapeLikeTerm("100%")).toBe("100\\%");
    expect(escapeLikeTerm("snake_case")).toBe("snake\\_case");
    expect(escapeLikeTerm("__init__")).toBe("\\_\\_init\\_\\_");
  });

  it("escapes the escape character itself, and only once", () => {
    // A single pass, so the backslash produced by escaping `%` is not then
    // treated as an input backslash and escaped again.
    expect(escapeLikeTerm("a\\b")).toBe("a\\\\b");
    expect(escapeLikeTerm("\\%")).toBe("\\\\\\%");
  });

  it("leaves an ordinary term untouched", () => {
    expect(escapeLikeTerm("mustache")).toBe("mustache");
    expect(escapeLikeTerm("")).toBe("");
    // Characters that are special to regex but not to LIKE stay as they are.
    expect(escapeLikeTerm("c++ (v2) [x]*")).toBe("c++ (v2) [x]*");
  });
});

describe("likeContains", () => {
  it("wraps the escaped term, so the outer percents stay wildcards", () => {
    expect(likeContains("tea")).toBe("%tea%");
    expect(likeContains("_")).toBe("%\\_%");
    expect(likeContains("%")).toBe("%\\%%");
  });

  it("does not collapse to a match-everything pattern", () => {
    // The regression, stated as an assertion: before the fix these were `%_%`
    // and `%%%`, which Postgres reads as "any non-empty string" and "anything".
    expect(likeContains("_")).not.toBe("%_%");
    expect(likeContains("%")).not.toBe("%%%");
  });

  it("is what a search for an empty string would produce", () => {
    // Routes guard against this upstream (the query schemas trim and drop
    // blanks); recorded so a change here is a deliberate one.
    expect(likeContains("")).toBe("%%");
  });
});

// ---------------------------------------------------------------------------
// Drift guard
// ---------------------------------------------------------------------------

const SRC_ROOT = join(import.meta.dirname, "..", "..", "..", "src");

// The helper is allowed to build the pattern; it is the definition of how.
const ALLOWED = new Set(["modules/shared/like.ts"]);

function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...tsFilesUnder(full));
    else if (name.endsWith(".ts")) out.push(full);
  }
  return out;
}

describe("LIKE patterns are built in one place", () => {
  it("no module interpolates a term into a %…% pattern itself", () => {
    // Matches a template literal that opens with a percent sign immediately
    // followed by a substitution — the exact shape of `%${term}%`, and the
    // shape both bugs had.
    const inlinePattern = /`%\$\{/;

    const offenders = tsFilesUnder(SRC_ROOT)
      .filter((f) => inlinePattern.test(readFileSync(f, "utf8")))
      .map((f) => relative(SRC_ROOT, f).split(sep).join("/"))
      .filter((rel) => !ALLOWED.has(rel));

    // If this fails, the named file is one `likeContains()` away from correct:
    // import it from "@/modules/shared/like" and pass the raw term.
    expect(offenders).toEqual([]);
  });
});
