import { describe, it, expect } from "vitest";
import { buildEventsFromItinerary, parseActivityTime } from "@/modules/trip-groups/calendar-export";
import type { TripItinerary } from "@/modules/trip-groups/consolidator";

const TZ = "America/Chicago";

function itinerary(activities: { time: string | null; title: string; notes?: string | null }[], date: string | null = "2026-07-25"): TripItinerary {
  return {
    summary: "s",
    days: [
      {
        day: 1,
        title: "Athens",
        date,
        location: "Athens",
        country: "Greece",
        meals: { breakfast: null, lunch: null, dinner: null },
        activities: activities.map((a) => ({ time: a.time, title: a.title, notes: a.notes ?? null })),
      },
    ],
  };
}

describe("parseActivityTime (SHAN-554)", () => {
  it("accepts 24h H:MM and HH:MM", () => {
    expect(parseActivityTime("09:05")).toBe(9 * 60 + 5);
    expect(parseActivityTime("9:05")).toBe(9 * 60 + 5);
    expect(parseActivityTime(" 23:59 ")).toBe(23 * 60 + 59);
    expect(parseActivityTime("0:00")).toBe(0);
  });

  it("rejects anything that is not a 24h clock time", () => {
    for (const raw of ["9am", "morning", "~14:00", "14:00-16:00", "24:00", "9:5", "12:60", "", "9.30"]) {
      expect(parseActivityTime(raw)).toBeNull();
    }
  });
});

describe("buildEventsFromItinerary (SHAN-554)", () => {
  it("pads a single-digit hour instead of emitting an invalid dateTime", () => {
    const { events } = buildEventsFromItinerary("Trip", "g1", itinerary([{ time: "9:00", title: "Acropolis" }]), TZ);
    expect(events[0].start).toEqual({ dateTime: "2026-07-25T09:00:00", timeZone: TZ });
    expect(events[0].end).toEqual({ dateTime: "2026-07-25T10:00:00", timeZone: TZ });
  });

  it("rolls a late activity's end onto the next day instead of a zero-length event", () => {
    const { events } = buildEventsFromItinerary("Trip", "g1", itinerary([{ time: "23:30", title: "Night ferry" }]), TZ);
    expect(events[0].start.dateTime).toBe("2026-07-25T23:30:00");
    expect(events[0].end.dateTime).toBe("2026-07-26T00:30:00");
  });

  it("rolls across a month boundary", () => {
    const { events } = buildEventsFromItinerary("Trip", "g1", itinerary([{ time: "23:15", title: "x" }], "2026-07-31"), TZ);
    expect(events[0].end.dateTime).toBe("2026-08-01T00:15:00");
  });

  it("exports an unparseable time as untimed, keeping its text in the all-day event", () => {
    const { events } = buildEventsFromItinerary(
      "Trip",
      "g1",
      itinerary([
        { time: "9am", title: "Ferry", notes: "Piraeus gate E7" },
        { time: null, title: "Wander Plaka" },
        { time: "14:00", title: "Museum" },
      ]),
      TZ,
    );
    expect(events).toHaveLength(2);
    expect(events[0].summary).toBe("Museum");
    const allDay = events[1];
    expect(allDay.start).toEqual({ date: "2026-07-25" });
    expect(allDay.end).toEqual({ date: "2026-07-26" });
    expect(allDay.description).toBe("• 9am Ferry — Piraeus gate E7\n• Wander Plaka");
    for (const e of events) {
      if (e.start.dateTime) expect(e.start.dateTime).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00$/);
    }
  });

  it("skips undated days and tags every event with the group id", () => {
    const { events, skippedDays } = buildEventsFromItinerary("Trip", "g1", itinerary([{ time: "10:00", title: "x" }], null), TZ);
    expect(events).toEqual([]);
    expect(skippedDays).toEqual([1]);

    const dated = buildEventsFromItinerary("Trip", "g1", itinerary([{ time: "10:00", title: "x" }]), TZ);
    for (const e of dated.events) expect(e.extendedProperties.private.shaneTripGroup).toBe("g1");
  });
});
