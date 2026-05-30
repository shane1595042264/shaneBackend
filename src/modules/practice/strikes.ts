/**
 * Pure functions for the derived practice state.
 *
 * No DB. No IO. Given an array of session_item rows (already filtered to
 * one user + one item) and the current thresholds, compute strike counts
 * by location, which locations are loaded, and whether the item is
 * solidified. Repos call this after fetching the rows.
 */

export interface Thresholds {
  setsPerStrike: number;
  strikesPerLoadedLocation: number;
  locationsToSolidify: number;
}

export interface SessionItemRow {
  itemId: string;
  locationId: string | null;
  setsCompleted: number;
  completedAt: Date | null;
}

export interface ProgressResult {
  strikeCountsByLocation: Map<string, number>; // locationId → strike count
  loadedLocations: string[];                    // locationIds where strikes >= threshold
  isSolidified: boolean;
  totalStrikes: number;
}

/**
 * Count strikes per location. A "strike" is a session_item with
 * setsCompleted >= setsPerStrike. Rows with null location_id are skipped
 * — strikes only count toward solidification when location is recorded.
 */
export function computeStrikeCountByLocation(
  rows: SessionItemRow[],
  t: Thresholds,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of rows) {
    if (r.locationId === null) continue;
    if (r.setsCompleted < t.setsPerStrike) continue;
    out.set(r.locationId, (out.get(r.locationId) ?? 0) + 1);
  }
  return out;
}

/** Locations whose strike count meets/exceeds strikesPerLoadedLocation. */
export function computeLoadedLocations(
  strikeCounts: Map<string, number>,
  t: Thresholds,
): string[] {
  const out: string[] = [];
  for (const [loc, count] of strikeCounts.entries()) {
    if (count >= t.strikesPerLoadedLocation) out.push(loc);
  }
  return out;
}

/** Single-call convenience: rows → full progress report. */
export function computeProgress(rows: SessionItemRow[], t: Thresholds): ProgressResult {
  const strikeCountsByLocation = computeStrikeCountByLocation(rows, t);
  const loadedLocations = computeLoadedLocations(strikeCountsByLocation, t);
  const totalStrikes = rows.filter((r) => r.setsCompleted >= t.setsPerStrike).length;
  return {
    strikeCountsByLocation,
    loadedLocations,
    isSolidified: loadedLocations.length >= t.locationsToSolidify,
    totalStrikes,
  };
}
