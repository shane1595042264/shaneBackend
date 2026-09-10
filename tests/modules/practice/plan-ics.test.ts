// tests/modules/practice/plan-ics.test.ts
// SHAN-473: the calendar feed. `today` is injected, so these assert the exact
// bytes a subscriber gets rather than whatever the clock happens to say.
import { describe, it, expect } from "vitest";
import { buildPlanIcs, estimateSessionSeconds, foldLine, type IcsPlan } from "@/modules/practice/plan-ics";

const block = (over: Partial<IcsPlan["days"][number]["blocks"][number]> = {}) => ({
  title: "Hollow body hold",
  kind: "skill",
  mode: "time",
  targetSeconds: 60,
  targetReps: null,
  sets: 3,
  restSeconds: 30,
  ...over,
});

const plan = (over: Partial<IcsPlan> = {}): IcsPlan => ({
  id: "11111111-1111-1111-1111-111111111111",
  title: "Handstand base",
  goal: "Freestanding 30s",
  discipline: "gymnastics",
  startDate: "2026-09-07", // a Monday
  daysPerWeek: 1,
  sessionTime: null,
  reminderMinutes: null,
  days: [{ id: "d1", position: 1, label: "Day 1", weekday: 1, notes: null, blocks: [block()] }],
  ...over,
});

const opts = { today: "2026-09-07", now: new Date("2026-09-07T12:00:00Z") };

describe("buildPlanIcs", () => {
  it("wraps the events in a well-formed calendar with CRLF line endings", () => {
    const ics = buildPlanIcs(plan(), opts);
    expect(ics.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
    expect(ics.endsWith("END:VCALENDAR\r\n")).toBe(true);
    expect(ics).toContain("VERSION:2.0");
    expect(ics).toContain("X-WR-CALNAME:Handstand base");
    expect(ics.split("\n").every((l) => l === "" || l.endsWith("\r"))).toBe(true);
  });

  it("emits one event per scheduled date over the horizon, not per calendar day", () => {
    const ics = buildPlanIcs(plan(), { ...opts, horizonDays: 21, backfillDays: 0 });
    const events = ics.match(/BEGIN:VEVENT/g) ?? [];
    expect(events).toHaveLength(4); // four Mondays in 21 days
    expect(ics).toContain("DTSTART;VALUE=DATE:20260907");
    expect(ics).toContain("DTSTART;VALUE=DATE:20260914");
  });

  it("backfills so a fresh subscription still shows the current week", () => {
    const ics = buildPlanIcs(plan(), { ...opts, today: "2026-09-09", horizonDays: 0 });
    expect(ics).toContain("DTSTART;VALUE=DATE:20260907");
  });

  it("uses a stable per-date UID so a refresh updates rather than duplicates", () => {
    const first = buildPlanIcs(plan(), opts);
    const second = buildPlanIcs(plan(), { ...opts, now: new Date("2026-09-08T09:00:00Z") });
    const uid = "UID:plan-11111111-1111-1111-1111-111111111111-2026-09-07@shanejli.com";
    expect(first).toContain(uid);
    expect(second).toContain(uid);
  });

  it("writes all-day events when the plan has no session time", () => {
    const ics = buildPlanIcs(plan(), opts);
    expect(ics).toContain("DTSTART;VALUE=DATE:20260907");
    expect(ics).toContain("DTEND;VALUE=DATE:20260908");
    // The calendar-level REFRESH-INTERVAL also carries the word, so anchor the
    // negative assertion to a property line.
    expect(ics).not.toContain("\r\nDURATION:");
  });

  it("writes a floating local start plus an estimated duration when a time is set", () => {
    const ics = buildPlanIcs(plan({ sessionTime: "07:30" }), opts);
    expect(ics).toContain("DTSTART:20260907T073000");
    // 3 × 60s work + 2 × 30s rest = 240s, floored at the 15 min minimum.
    expect(ics).toContain("DURATION:PT15M");
    expect(ics).not.toContain("TZID");
  });

  it("adds a VALARM only when a reminder is configured", () => {
    expect(buildPlanIcs(plan(), opts)).not.toContain("BEGIN:VALARM");
    const ics = buildPlanIcs(plan({ reminderMinutes: 30 }), opts);
    expect(ics).toContain("BEGIN:VALARM");
    expect(ics).toContain("TRIGGER:-PT30M");
    expect(ics).toContain("ACTION:DISPLAY");
  });

  it("treats a zero-minute reminder as at-start rather than negative zero", () => {
    expect(buildPlanIcs(plan({ reminderMinutes: 0 }), opts)).toContain("TRIGGER:PT0M");
  });

  it("names both days in the summary when two land on the same date", () => {
    const ics = buildPlanIcs(
      plan({
        daysPerWeek: 2,
        days: [
          { id: "d1", position: 1, label: "Push", weekday: 1, notes: null, blocks: [block()] },
          { id: "d2", position: 2, label: "Pull", weekday: 1, notes: null, blocks: [block()] },
        ],
      }),
      opts,
    );
    expect(ics).toContain("SUMMARY:Handstand base — Push + Pull (gymnastics)");
  });

  it("escapes the reserved characters in a title", () => {
    const ics = buildPlanIcs(plan({ title: "Legs; arms, core\\back", discipline: null }), opts);
    expect(ics).toContain("X-WR-CALNAME:Legs\\; arms\\, core\\\\back");
  });

  it("puts the block list in the description as escaped newlines", () => {
    const ics = buildPlanIcs(plan(), opts);
    const line = ics.split("\r\n").find((l) => l.startsWith("DESCRIPTION:"));
    expect(line).toBeDefined();
    expect(line).toContain("\\n");
    expect(ics).toContain("Hollow body hold (3 x 60s)");
  });

  it("produces a calendar with no events for a plan that has no days", () => {
    const ics = buildPlanIcs(plan({ days: [] }), opts);
    expect(ics).not.toContain("BEGIN:VEVENT");
    expect(ics).toContain("END:VCALENDAR");
  });
});

describe("estimateSessionSeconds", () => {
  const day = (blocks: ReturnType<typeof block>[]) => ({
    id: "d1",
    position: 1,
    label: "Day 1",
    weekday: null,
    notes: null,
    blocks,
  });

  it("counts work plus the rests between sets, not after the last one", () => {
    // 10 × 600s + 9 × 60s = 6540s, under the four-hour cap.
    const seconds = estimateSessionSeconds([
      day([block({ targetSeconds: 600, sets: 10, restSeconds: 60 })]),
    ]);
    expect(seconds).toBe(6540);
  });

  it("assumes a minute a set for reps blocks, which have no clock", () => {
    const seconds = estimateSessionSeconds([
      day([block({ mode: "reps", targetSeconds: null, targetReps: 12, sets: 30, restSeconds: 0 })]),
    ]);
    expect(seconds).toBe(1800);
  });

  it("floors a short session at 15 minutes and caps a long one at four hours", () => {
    expect(estimateSessionSeconds([day([block({ sets: 1, restSeconds: 0 })])])).toBe(900);
    expect(
      estimateSessionSeconds([day([block({ targetSeconds: 3600, sets: 20, restSeconds: 0 })])]),
    ).toBe(4 * 3600);
  });
});

describe("foldLine", () => {
  it("leaves a short line alone", () => {
    expect(foldLine("SUMMARY:short")).toBe("SUMMARY:short");
  });

  it("folds past 75 octets with a leading space on continuations", () => {
    const folded = foldLine(`SUMMARY:${"a".repeat(200)}`);
    const parts = folded.split("\r\n");
    expect(parts.length).toBeGreaterThan(1);
    expect(parts[0]!.length).toBe(75);
    expect(parts.slice(1).every((p) => p.startsWith(" "))).toBe(true);
    expect(parts.join("").replace(/ /g, "")).toBe(`SUMMARY:${"a".repeat(200)}`);
  });

  it("counts octets, and never splits a multi-byte character", () => {
    const folded = foldLine(`SUMMARY:${"é".repeat(60)}`);
    // Every emitted chunk must still decode cleanly — a split sequence would
    // show up as the replacement character.
    expect(folded).not.toContain("�");
    expect(folded.split("\r\n ").join("")).toBe(`SUMMARY:${"é".repeat(60)}`);
  });
});
