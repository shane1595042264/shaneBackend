// tests/modules/shared/validators.test.ts
import { describe, it, expect } from "vitest";
import {
  containsInFlightUpload,
  IN_FLIGHT_UPLOAD_REGEX,
  IN_FLIGHT_UPLOAD_MESSAGE,
  trimmedRequired,
  trimmedOptional,
  trimmedNullish,
  trimmedLabels,
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

// SHAN-433: whitespace-only trim helpers shared by the knowledge & vocabulary
// write paths (both persist the same vocabWords columns — SHAN-401 parity).
describe("trimmedRequired", () => {
  const schema = trimmedRequired(10);

  it("strips leading/trailing whitespace", () => {
    expect(schema.parse("  hi  ")).toBe("hi");
  });

  it("rejects a whitespace-only value", () => {
    expect(schema.safeParse("   ").success).toBe(false);
    expect(schema.safeParse("\t\n").success).toBe(false);
  });

  it("rejects an empty string", () => {
    expect(schema.safeParse("").success).toBe(false);
  });

  it("enforces the max on the trimmed length", () => {
    // 11 non-space chars -> over max(10)
    expect(schema.safeParse("abcdefghijk").success).toBe(false);
    // padding trims away so the real content is within bounds
    expect(schema.parse("   abcdefghij   ")).toBe("abcdefghij");
  });
});

describe("trimmedOptional", () => {
  const schema = trimmedOptional(10);

  it("returns undefined for an absent value", () => {
    expect(schema.parse(undefined)).toBeUndefined();
  });

  it("collapses a whitespace-only value to undefined (not persisted)", () => {
    expect(schema.parse("   ")).toBeUndefined();
  });

  it("trims padding off a real value", () => {
    expect(schema.parse("  hi  ")).toBe("hi");
  });

  it("still rejects an oversized value", () => {
    expect(schema.safeParse("abcdefghijk").success).toBe(false);
  });
});

describe("trimmedNullish", () => {
  const schema = trimmedNullish(10);

  it("preserves an explicit null", () => {
    expect(schema.parse(null)).toBeNull();
  });

  it("preserves an absent (undefined) value", () => {
    expect(schema.parse(undefined)).toBeUndefined();
  });

  it("collapses a whitespace-only value to null", () => {
    expect(schema.parse("   ")).toBeNull();
  });

  it("trims padding off a real value", () => {
    expect(schema.parse("  book  ")).toBe("book");
  });
});

describe("trimmedLabels", () => {
  const schema = trimmedLabels(10, 3);

  it("returns undefined when absent", () => {
    expect(schema.parse(undefined)).toBeUndefined();
  });

  it("trims each label and drops whitespace-only entries", () => {
    expect(schema.parse([" a ", "   ", "b"])).toEqual(["a", "b"]);
  });

  it("drops to an empty array when every label is blank", () => {
    expect(schema.parse(["   ", "\t"])).toEqual([]);
  });

  it("enforces the array size cap before trimming", () => {
    expect(schema.safeParse(["a", "b", "c", "d"]).success).toBe(false);
  });

  it("enforces the per-entry length cap", () => {
    expect(schema.safeParse(["abcdefghijk"]).success).toBe(false);
  });
});
