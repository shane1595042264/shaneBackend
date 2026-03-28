import { describe, it, expect } from "vitest";
import { extractOgImage, truncateHtml } from "@/modules/rng-capitalist/scraper";

describe("extractOgImage", () => {
  it("extracts og:image from meta tag", () => {
    const html = `<html><head><meta property="og:image" content="https://example.com/image.jpg" /></head></html>`;
    expect(extractOgImage(html)).toBe("https://example.com/image.jpg");
  });
  it("returns null when no og:image found", () => {
    expect(extractOgImage(`<html><head><title>Test</title></head></html>`)).toBeNull();
  });
  it("handles single quotes", () => {
    const html = `<meta property='og:image' content='https://example.com/img.png' />`;
    expect(extractOgImage(html)).toBe("https://example.com/img.png");
  });
});

describe("truncateHtml", () => {
  it("truncates to specified limit", () => {
    expect(truncateHtml("a".repeat(20000), 10000).length).toBeLessThanOrEqual(10000);
  });
  it("returns full HTML if under limit", () => {
    const html = "<html>short</html>";
    expect(truncateHtml(html, 10000)).toBe(html);
  });
  it("strips script and style tags", () => {
    const html = `<head><style>.foo{}</style></head><body><p>text</p><script>alert(1)</script></body>`;
    const result = truncateHtml(html, 10000);
    expect(result).not.toContain("<script>");
    expect(result).not.toContain("<style>");
    expect(result).toContain("text");
  });
});
