// Location-memorization technique (SHAN-339). The user marks a knowledge card
// with each distinct place they've practiced it; once they've practiced it at
// LONG_TERM_THRESHOLD different locations the card is "long-term memorized".

/** Distinct locations required before a card is considered long-term memorized. */
export const LONG_TERM_THRESHOLD = 7;

/**
 * Normalize a raw list of location names into the canonical set stored on a card:
 * trimmed, empties dropped, and de-duplicated case-insensitively while preserving
 * the first-seen casing and order.
 */
export function normalizeLocations(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of input) {
    if (typeof raw !== "string") continue;
    const name = raw.trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(name);
  }
  return result;
}

/** A card is long-term memorized once it has been practiced at 7+ distinct locations. */
export function computeLongTermMemorized(locations: string[]): boolean {
  return locations.length >= LONG_TERM_THRESHOLD;
}
