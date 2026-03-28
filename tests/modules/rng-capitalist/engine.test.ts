import { describe, it, expect } from "vitest";
import { calculateThreshold, rollD20, determineVerdict } from "@/modules/rng-capitalist/engine";

describe("calculateThreshold", () => {
  it("calculates 200/1000 * 20 = 4", () => {
    expect(calculateThreshold(200, 1000)).toBe(4);
  });
  it("rounds 14.4 to 14 (Math.round)", () => {
    expect(calculateThreshold(720, 1000)).toBe(14);
  });
  it("rounds 14.5 to 15 (Math.round)", () => {
    expect(calculateThreshold(725, 1000)).toBe(15);
  });
  it("returns > 20 when price exceeds budget", () => {
    expect(calculateThreshold(1500, 1000)).toBe(30);
  });
  it("returns 0 for trivial price", () => {
    expect(calculateThreshold(0.01, 1000)).toBe(0);
  });
  it("returns 21 for zero budget", () => {
    expect(calculateThreshold(100, 0)).toBe(21);
  });
  it("returns 21 for negative budget", () => {
    expect(calculateThreshold(100, -500)).toBe(21);
  });
});

describe("rollD20", () => {
  it("returns 1-20 inclusive", () => {
    for (let i = 0; i < 100; i++) {
      const roll = rollD20();
      expect(roll).toBeGreaterThanOrEqual(1);
      expect(roll).toBeLessThanOrEqual(20);
    }
  });
});

describe("determineVerdict", () => {
  it("necessity for non-entertainment", () => {
    expect(determineVerdict({ isEntertainment: false, isBanned: false, threshold: 5, roll: 10 })).toBe("necessity");
  });
  it("banned for banned category", () => {
    expect(determineVerdict({ isEntertainment: true, isBanned: true, threshold: 5, roll: 10 })).toBe("banned");
  });
  it("too_expensive when threshold > 20", () => {
    expect(determineVerdict({ isEntertainment: true, isBanned: false, threshold: 25, roll: 10 })).toBe("too_expensive");
  });
  it("approved when threshold <= 0", () => {
    expect(determineVerdict({ isEntertainment: true, isBanned: false, threshold: 0, roll: 10 })).toBe("approved");
  });
  it("approved when roll >= threshold", () => {
    expect(determineVerdict({ isEntertainment: true, isBanned: false, threshold: 4, roll: 4 })).toBe("approved");
  });
  it("denied when roll < threshold", () => {
    expect(determineVerdict({ isEntertainment: true, isBanned: false, threshold: 4, roll: 3 })).toBe("denied");
  });
});
