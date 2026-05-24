import { describe, it, expect } from "vitest";
import { extractTitle } from "@/modules/trips/title";

describe("extractTitle", () => {
  it("returns the <title> when present", () => {
    expect(extractTitle("<html><head><title>Tokyo 2026</title></head><body></body></html>")).toBe("Tokyo 2026");
  });

  it("trims and collapses whitespace inside <title>", () => {
    expect(extractTitle("<title>\n  Tokyo   2026\n</title>")).toBe("Tokyo 2026");
  });

  it("decodes basic HTML entities", () => {
    expect(extractTitle("<title>Tokyo &amp; Kyoto &mdash; 2026</title>")).toBe("Tokyo & Kyoto — 2026");
  });

  it("falls back to first <h1> if <title> is missing", () => {
    expect(extractTitle("<body><h1>Italy June 2026</h1></body>")).toBe("Italy June 2026");
  });

  it("strips inner tags from <h1>", () => {
    expect(extractTitle("<h1>Tokyo <span>day 1</span></h1>")).toBe("Tokyo day 1");
  });

  it("prefers <title> over <h1>", () => {
    expect(extractTitle("<title>Real Title</title><h1>Different H1</h1>")).toBe("Real Title");
  });

  it("returns null when nothing is found", () => {
    expect(extractTitle("<p>just a paragraph</p>")).toBeNull();
  });

  it("treats an empty <title> as missing and falls back to <h1>", () => {
    expect(extractTitle("<title>   </title><h1>Backup</h1>")).toBe("Backup");
  });

  it("caps the title at 200 chars", () => {
    const long = "x".repeat(500);
    const got = extractTitle(`<title>${long}</title>`);
    expect(got?.length).toBe(200);
  });
});
