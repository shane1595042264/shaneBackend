import { describe, it, expect } from "vitest";
import {
  computeStrikeCountByLocation,
  computeLoadedLocations,
  computeProgress,
  type Thresholds,
  type SessionItemRow,
} from "@/modules/practice/strikes";

const T: Thresholds = {
  setsPerStrike: 5,
  strikesPerLoadedLocation: 5,
  locationsToSolidify: 7,
};

function row(opts: Partial<SessionItemRow> & { sets: number; loc: string | null }): SessionItemRow {
  return {
    itemId: opts.itemId ?? "item-1",
    locationId: opts.loc,
    setsCompleted: opts.sets,
    completedAt: opts.completedAt ?? new Date("2026-05-01"),
  };
}

describe("computeStrikeCountByLocation", () => {
  it("returns empty map for no rows", () => {
    expect(computeStrikeCountByLocation([], T).size).toBe(0);
  });

  it("ignores rows with sets_completed below the threshold", () => {
    const rows = [row({ sets: 4, loc: "Studio" }), row({ sets: 4, loc: "Studio" })];
    expect(computeStrikeCountByLocation(rows, T).size).toBe(0);
  });

  it("counts rows where sets_completed >= setsPerStrike", () => {
    const rows = [row({ sets: 5, loc: "Studio" }), row({ sets: 6, loc: "Studio" })];
    const out = computeStrikeCountByLocation(rows, T);
    expect(out.get("Studio")).toBe(2);
  });

  it("ignores rows with null location", () => {
    const rows = [row({ sets: 5, loc: null }), row({ sets: 5, loc: "Studio" })];
    const out = computeStrikeCountByLocation(rows, T);
    expect(out.get("Studio")).toBe(1);
    expect(out.has(null as any)).toBe(false);
  });
});

describe("computeLoadedLocations", () => {
  it("returns locations whose strike count >= strikesPerLoadedLocation", () => {
    const counts = new Map([["A", 5], ["B", 4], ["C", 10]]);
    expect(computeLoadedLocations(counts, T).sort()).toEqual(["A", "C"]);
  });
});

describe("computeProgress (end-to-end)", () => {
  it("solidified when loaded location count >= locationsToSolidify", () => {
    const rows: SessionItemRow[] = [];
    for (const loc of ["A", "B", "C", "D", "E", "F", "G"]) {
      for (let i = 0; i < 5; i++) rows.push(row({ sets: 5, loc }));
    }
    const p = computeProgress(rows, T);
    expect(p.loadedLocations.length).toBe(7);
    expect(p.isSolidified).toBe(true);
    expect(p.totalStrikes).toBe(35);
  });

  it("not solidified when only 6 loaded locations", () => {
    const rows: SessionItemRow[] = [];
    for (const loc of ["A", "B", "C", "D", "E", "F"]) {
      for (let i = 0; i < 5; i++) rows.push(row({ sets: 5, loc }));
    }
    const p = computeProgress(rows, T);
    expect(p.loadedLocations.length).toBe(6);
    expect(p.isSolidified).toBe(false);
  });

  it("strikeCountsByLocation surfaces partial progress (3/5 strikes at one place)", () => {
    const rows = Array.from({ length: 3 }, () => row({ sets: 5, loc: "Studio" }));
    const p = computeProgress(rows, T);
    expect(p.strikeCountsByLocation.get("Studio")).toBe(3);
    expect(p.loadedLocations.length).toBe(0);
    expect(p.isSolidified).toBe(false);
  });

  it("respects custom thresholds (3/3/3)", () => {
    const custom: Thresholds = { setsPerStrike: 3, strikesPerLoadedLocation: 3, locationsToSolidify: 3 };
    const rows: SessionItemRow[] = [];
    for (const loc of ["A", "B", "C"]) {
      for (let i = 0; i < 3; i++) rows.push(row({ sets: 3, loc }));
    }
    const p = computeProgress(rows, custom);
    expect(p.isSolidified).toBe(true);
  });
});
