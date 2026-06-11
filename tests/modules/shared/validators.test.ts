// tests/modules/shared/validators.test.ts
import { describe, it, expect } from "vitest";
import {
  containsInFlightUpload,
  IN_FLIGHT_UPLOAD_REGEX,
  IN_FLIGHT_UPLOAD_MESSAGE,
} from "@/modules/shared/validators";

describe("containsInFlightUpload", () => {
  it("flags the literal token format the editor produces", () => {
    // markdown-editor.tsx: `uploading-${Math.random().toString(36).slice(2,10)}-${Date.now()}`
    expect(
      containsInFlightUpload(
        "![image.png](uploading-bt8rm24t-1780955450594)",
      ),
    ).toBe(true);
  });

  it("flags an in-flight marker buried in multi-line content", () => {
    const content = [
      "finally finished visa appointment.",
      "Also today I learned:",
      "![image.png](uploading-bt8rm24t-1780955450594)",
    ].join("\n");
    expect(containsInFlightUpload(content)).toBe(true);
  });

  it("flags any alt-text variant", () => {
    expect(containsInFlightUpload("![](uploading-abc-123)")).toBe(true);
    expect(
      containsInFlightUpload("prefix ![my photo](uploading-xyz-9) suffix"),
    ).toBe(true);
  });

  it("passes a real resolved image URL", () => {
    expect(
      containsInFlightUpload(
        "![image.png](/api/journal/images/a1b2c3d4-5678-90ab-cdef-1234567890ab)",
      ),
    ).toBe(false);
  });

  it("passes plain prose with no image markdown", () => {
    expect(containsInFlightUpload("just a normal journal entry")).toBe(false);
    expect(containsInFlightUpload("")).toBe(false);
  });

  it("does not match a non-image markdown link with 'uploading' in the URL", () => {
    // The regex requires the leading `!` (image syntax), not a regular link.
    expect(
      containsInFlightUpload("[click](https://example.com/uploading-page)"),
    ).toBe(false);
  });

  it("exposes a stable error message for clients to surface", () => {
    expect(IN_FLIGHT_UPLOAD_MESSAGE).toMatch(/upload/i);
  });

  it("regex is exported so callers can compose their own validators", () => {
    expect(IN_FLIGHT_UPLOAD_REGEX.test("![](uploading-x-1)")).toBe(true);
  });
});
