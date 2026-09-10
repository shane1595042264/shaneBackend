// tests/modules/practice/plan-schedule.test.ts
// SHAN-473: the cadence resolver. Pure module, so no mocks — the whole point of
// pulling it out of the runner is that the schedule is assertable.
import { describe, it, expect } from "vitest";
import {
  nextScheduledSession,
  resolveCadence,
  scheduledDaysOn,
  scheduledSessions,
  type SchedulePlan,
} from "@/modules/practice/plan-schedule";

const day = (position: number, weekday: number | null = null) => ({
  id: `d${position}`,
  position,
  label: `Day ${position}`,
  weekday,
});

// 2026-09-07 is a Monday; the dates below are that week unless stated.
const MON = "2026-09-07";
const TUE = "2026-09-08";
const WED = "2026-09-09";
const THU = "2026-09-10";
const FRI = "2026-09-11";
const SAT = "2026-09-12";
const SUN = "2026-09-13";

const labels = (plan: SchedulePlan, iso: string) =>
  scheduledDaysOn(plan, iso).map((d) => d.label);

describe("resolveCadence", () => {
  it("gives floating days the spread weekdays daysPerWeek allows", () => {
    const cadence = resolveCadence({
      startDate: null,
      daysPerWeek: 3,
      days: [day(1), day(2), day(3)],
    });
    expect(cadence.floatingWeekdays).toEqual([1, 3, 5]); // Mon, Wed, Fri
    expect(cadence.floatingDays).toHaveLength(3);
  });

  it("falls back to the day count when daysPerWeek is unset", () => {
    const cadence = resolveCadence({ startDate: null, daysPerWeek: null, days: [day(1), day(2)] });
    expect(cadence.floatingWeekdays).toEqual([1, 3]);
  });

  it("keeps floating slots clear of the weekdays pinned days already own", () => {
    const cadence = resolveCadence({
      startDate: null,
      daysPerWeek: 3,
      days: [day(1, 1), day(2), day(3)],
    });
    expect(cadence.pinned.get(1)?.map((d) => d.label)).toEqual(["Day 1"]);
    expect(cadence.floatingWeekdays).toEqual([3, 5]); // Mon is taken
  });

  it("still gives floating days a slot when daysPerWeek is fully spent on pinned days", () => {
    const cadence = resolveCadence({
      startDate: null,
      daysPerWeek: 1,
      days: [day(1, 1), day(2)],
    });
    expect(cadence.floatingWeekdays).toHaveLength(1);
  });

  it("reserves no slots when every day is pinned", () => {
    const cadence = resolveCadence({
      startDate: null,
      daysPerWeek: 2,
      days: [day(1, 2), day(2, 4)],
    });
    expect(cadence.floatingWeekdays).toEqual([]);
  });
});

describe("scheduledDaysOn", () => {
  it("runs a pinned day on its weekday and nothing else", () => {
    const plan: SchedulePlan = { startDate: null, daysPerWeek: 1, days: [day(1, 3)] };
    expect(labels(plan, WED)).toEqual(["Day 1"]);
    expect(labels(plan, THU)).toEqual([]);
  });

  it("rotates floating days across weeks when there are more days than slots", () => {
    // 3 days, 2 sessions a week: Mon/Wed slots, so D1,D2 · D3,D1 · D2,D3.
    const plan: SchedulePlan = {
      startDate: MON,
      daysPerWeek: 2,
      days: [day(1), day(2), day(3)],
    };
    expect(labels(plan, MON)).toEqual(["Day 1"]);
    expect(labels(plan, WED)).toEqual(["Day 2"]);
    expect(labels(plan, "2026-09-14")).toEqual(["Day 3"]); // next Monday
    expect(labels(plan, "2026-09-16")).toEqual(["Day 1"]);
    expect(labels(plan, "2026-09-21")).toEqual(["Day 2"]);
    expect(labels(plan, "2026-09-23")).toEqual(["Day 3"]);
  });

  it("repeats the same weekly order when days and slots line up", () => {
    const plan: SchedulePlan = {
      startDate: MON,
      daysPerWeek: 3,
      days: [day(1), day(2), day(3)],
    };
    expect(labels(plan, MON)).toEqual(["Day 1"]);
    expect(labels(plan, WED)).toEqual(["Day 2"]);
    expect(labels(plan, FRI)).toEqual(["Day 3"]);
    expect(labels(plan, "2026-09-14")).toEqual(["Day 1"]);
    expect(labels(plan, TUE)).toEqual([]);
  });

  it("mixes a pinned day with a floating rotation", () => {
    const plan: SchedulePlan = {
      startDate: MON,
      daysPerWeek: 2,
      days: [day(1, 6), day(2), day(3)], // Day 1 every Saturday
    };
    expect(labels(plan, SAT)).toEqual(["Day 1"]);
    expect(labels(plan, MON)).toEqual(["Day 2"]);
    expect(labels(plan, "2026-09-14")).toEqual(["Day 3"]);
    expect(labels(plan, SUN)).toEqual([]);
  });

  it("schedules nothing before the start date", () => {
    const plan: SchedulePlan = { startDate: WED, daysPerWeek: 3, days: [day(1), day(2), day(3)] };
    expect(labels(plan, MON)).toEqual([]);
    expect(labels(plan, WED)).toEqual(["Day 1"]);
  });

  it("does not spend rotation positions on slots that fell before the start date", () => {
    // Start Wednesday: Monday's slot that week never happened, so Wednesday is
    // still the plan's first session rather than its second.
    const plan: SchedulePlan = { startDate: WED, daysPerWeek: 2, days: [day(1), day(2), day(3)] };
    expect(labels(plan, WED)).toEqual(["Day 1"]);
    expect(labels(plan, "2026-09-14")).toEqual(["Day 2"]);
    expect(labels(plan, "2026-09-16")).toEqual(["Day 3"]);
  });

  it("keeps the same rotation phase when unanchored", () => {
    const plan: SchedulePlan = { startDate: null, daysPerWeek: 2, days: [day(1), day(2), day(3)] };
    const first = labels(plan, MON);
    expect(first).toHaveLength(1);
    // 3 days over 2 slots a week: the cycle closes after six sessions, so the
    // same day comes back around three weeks later, not two.
    expect(labels(plan, "2026-09-21")).not.toEqual(first);
    expect(labels(plan, "2026-09-28")).toEqual(first);
  });

  it("returns an empty schedule for a plan with no days", () => {
    expect(labels({ startDate: null, daysPerWeek: 3, days: [] }, MON)).toEqual([]);
  });

  it("schedules both days when two are pinned to the same weekday", () => {
    const plan: SchedulePlan = { startDate: null, daysPerWeek: 2, days: [day(1, 2), day(2, 2)] };
    expect(labels(plan, TUE)).toEqual(["Day 1", "Day 2"]);
  });
});

describe("scheduledSessions", () => {
  it("lists only the scheduled dates in the range", () => {
    const plan: SchedulePlan = { startDate: MON, daysPerWeek: 3, days: [day(1), day(2), day(3)] };
    const sessions = scheduledSessions(plan, MON, SUN);
    expect(sessions.map((s) => s.isoDate)).toEqual([MON, WED, FRI]);
    expect(sessions[0]!.days[0]!.label).toBe("Day 1");
  });

  it("returns nothing for an inverted range", () => {
    const plan: SchedulePlan = { startDate: null, daysPerWeek: 3, days: [day(1)] };
    expect(scheduledSessions(plan, SUN, MON)).toEqual([]);
  });
});

describe("nextScheduledSession", () => {
  it("finds the next session on or after a rest day", () => {
    const plan: SchedulePlan = { startDate: MON, daysPerWeek: 3, days: [day(1), day(2), day(3)] };
    expect(nextScheduledSession(plan, TUE)?.isoDate).toBe(WED);
    expect(nextScheduledSession(plan, WED)?.isoDate).toBe(WED);
  });

  it("skips forward to the start date for a plan that has not begun", () => {
    const plan: SchedulePlan = {
      startDate: "2026-10-05",
      daysPerWeek: 3,
      days: [day(1), day(2), day(3)],
    };
    expect(nextScheduledSession(plan, MON)?.isoDate).toBe("2026-10-05");
  });

  it("returns null for a plan with no days", () => {
    expect(nextScheduledSession({ startDate: null, daysPerWeek: 3, days: [] }, MON)).toBeNull();
  });
});
