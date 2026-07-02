import { describe, it, expect } from "vitest";
import {
  normalizeLocations,
  computeLongTermMemorized,
  LONG_TERM_THRESHOLD,
} from "@/modules/knowledge/memorization";

describe("normalizeLocations (SHAN-339)", () => {
  it("trims, drops empties, and de-duplicates case-insensitively preserving first casing/order", () => {
    expect(
      normalizeLocations(["  Cafe ", "cafe", "LIBRARY", "", "   ", "Park", "library"])
    ).toEqual(["Cafe", "LIBRARY", "Park"]);
  });

  it("returns [] for non-array or non-string members", () => {
    expect(normalizeLocations(undefined)).toEqual([]);
    expect(normalizeLocations("Cafe")).toEqual([]);
    expect(normalizeLocations([1, null, {}, "Home"])).toEqual(["Home"]);
  });
});

describe("computeLongTermMemorized (SHAN-339)", () => {
  it(`is false below ${LONG_TERM_THRESHOLD} distinct locations`, () => {
    const six = ["a", "b", "c", "d", "e", "f"];
    expect(six.length).toBeLessThan(LONG_TERM_THRESHOLD);
    expect(computeLongTermMemorized(six)).toBe(false);
  });

  it(`is true at exactly ${LONG_TERM_THRESHOLD} distinct locations`, () => {
    const seven = ["a", "b", "c", "d", "e", "f", "g"];
    expect(computeLongTermMemorized(seven)).toBe(true);
  });

  it("counts distinct locations after normalization only", () => {
    // Seven raw entries, but duplicates collapse to well under the threshold.
    const locations = normalizeLocations(["a", "A", "a ", "b", "B", " b", "a"]);
    expect(locations).toEqual(["a", "b"]);
    expect(computeLongTermMemorized(locations)).toBe(false);
  });
});
