import { describe, it, expect } from "vitest";
import {
  computeChangedDays,
  itinerarySchema,
  mergeSuggestedItinerary,
  type TripItinerary,
} from "@/modules/trip-groups/consolidator";

const day = (n: number, title: string) => ({ day: n, title, location: null, activities: [] });
const itin = (summary: string, days: ReturnType<typeof day>[]): TripItinerary =>
  itinerarySchema.parse({ summary, days });

const titles = (i: TripItinerary | null) => i?.days.map((d) => `${d.day}:${d.title}`);

describe("mergeSuggestedItinerary (SHAN-563)", () => {
  const base = itin("Three days.", [day(1, "Athens"), day(2, "Hydra"), day(3, "Milos")]);

  it("two suggestions on different days both survive being approved in turn", () => {
    // Both members edited the same base. Approving A then B used to leave B's
    // whole snapshot, which still held the original day 1.
    const a = itin("Three days.", [day(1, "Athens food tour"), day(2, "Hydra"), day(3, "Milos")]);
    const b = itin("Three days.", [day(1, "Athens"), day(2, "Hydra"), day(3, "Milos boat")]);

    const afterA = mergeSuggestedItinerary(base, a, computeChangedDays(base, a), false);
    const afterB = mergeSuggestedItinerary(afterA, b, computeChangedDays(base, b), false);

    expect(titles(afterB)).toEqual(["1:Athens food tour", "2:Hydra", "3:Milos boat"]);
  });

  it("removes a changed day the proposal dropped and inserts one it added, in day order", () => {
    const proposed = itin("Three days.", [day(1, "Athens"), day(3, "Milos"), day(4, "Naxos")]);
    const merged = mergeSuggestedItinerary(base, proposed, [2, 4], false);
    expect(titles(merged)).toEqual(["1:Athens", "3:Milos", "4:Naxos"]);
  });

  it("takes the proposed summary only when the suggestion changed it", () => {
    const current = itin("Owner rewrote this.", base.days);
    const proposed = itin("Member's summary.", base.days);
    expect(mergeSuggestedItinerary(current, proposed, [], false)?.summary).toBe("Owner rewrote this.");
    expect(mergeSuggestedItinerary(current, proposed, [], true)?.summary).toBe("Member's summary.");
  });

  it("writes the proposal as-is when there is no stored itinerary", () => {
    const proposed = itin("Fresh.", [day(1, "Athens")]);
    expect(mergeSuggestedItinerary(null, proposed, [1], true)).toEqual(proposed);
  });

  it("returns null when the merge would leave no days", () => {
    const current = itin("One day left.", [day(2, "Hydra")]);
    const proposed = itin("Three days.", [day(1, "Athens")]);
    expect(mergeSuggestedItinerary(current, proposed, [2], false)).toBeNull();
  });
});
