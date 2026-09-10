// src/modules/practice/plan-schedule.ts
// Turns a plan's days into concrete calendar dates (SHAN-473, Phase 4 of
// SHAN-467). Pure: no clock, no DB, no randomness — feed it a plan and a date
// range and it answers the same thing every time, which is what makes both the
// ICS feed and the frontend calendar trustworthy.
//
// The rules, in one place because Phase 3 guessed at them:
//   * A day with a pinned `weekday` runs on that weekday, every week.
//   * A day with `weekday === null` is floating. Floating days rotate through
//     whatever weekly slots are left over, so a 3-day plan running 2×/week goes
//     D1,D2 · D3,D1 · D2,D3 — the A/B/A shape a real program has, instead of
//     Phase 3's "no weekday match, so fall back to day one" every single day.
//   * How many slots a week: `daysPerWeek`, falling back to the number of days.
//   * Which weekdays those slots land on: SPREAD_PREFERENCE minus the weekdays
//     the pinned days already own, so sessions stay spaced out.
//
// The rotation ordinal is anchored on `startDate` (or a fixed epoch Monday when
// the plan has none) so the phase of the rotation never drifts.
//
// NOTE: this file is mirrored at shaneFrontend/apps/shell/lib/plan-schedule.ts.
// Cross-repo imports are banned, so the two copies have to be kept in step by
// hand — change one, change the other.

export interface ScheduleDay {
  id: string;
  position: number;
  label: string;
  weekday: number | null;
}

/**
 * Generic over the day type so a caller carrying richer days (blocks, notes)
 * gets those same objects back out instead of a narrowed copy.
 */
export interface SchedulePlan<D extends ScheduleDay = ScheduleDay> {
  startDate: string | null;
  daysPerWeek: number | null;
  days: D[];
}

/**
 * Weekday preference for placing floating sessions: spread first (Mon/Wed/Fri),
 * then fill in, weekend last. 0 = Sunday .. 6 = Saturday, matching JS getDay()
 * and the `weekday` column.
 */
const SPREAD_PREFERENCE = [1, 3, 5, 2, 4, 6, 0];

/** A Monday, so week arithmetic on an unanchored plan still starts on Monday. */
const EPOCH_MONDAY = "1970-01-05";

const DAY_MS = 86_400_000;

function toUtcMs(isoDate: string): number {
  return Date.parse(`${isoDate}T00:00:00Z`);
}

function toIso(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function weekdayOf(isoDate: string): number {
  return new Date(toUtcMs(isoDate)).getUTCDay();
}

/** Monday = 0 .. Sunday = 6. Weeks start on Monday here. */
function mondayIndex(weekday: number): number {
  return (weekday + 6) % 7;
}

function weekStartMs(isoDate: string): number {
  const ms = toUtcMs(isoDate);
  return ms - mondayIndex(new Date(ms).getUTCDay()) * DAY_MS;
}

export function addDays(isoDate: string, days: number): string {
  return toIso(toUtcMs(isoDate) + days * DAY_MS);
}

interface Cadence<D extends ScheduleDay = ScheduleDay> {
  /** Pinned days grouped by the weekday they own. */
  pinned: Map<number, D[]>;
  /** Weekdays the floating rotation uses, in Monday-first order. */
  floatingWeekdays: number[];
  /** Floating days in plan order — the rotation cycles through these. */
  floatingDays: D[];
  anchor: string;
}

/**
 * Resolve a plan's weekly shape once, so a range query doesn't recompute it per
 * date. Exported for the UI, which wants to explain the cadence in words.
 */
export function resolveCadence<D extends ScheduleDay>(plan: SchedulePlan<D>): Cadence<D> {
  const days = [...plan.days].sort((a, b) => a.position - b.position);
  const pinned = new Map<number, D[]>();
  const floatingDays: D[] = [];

  for (const day of days) {
    if (day.weekday === null) {
      floatingDays.push(day);
      continue;
    }
    const list = pinned.get(day.weekday);
    if (list) list.push(day);
    else pinned.set(day.weekday, [day]);
  }

  const perWeek = plan.daysPerWeek ?? days.length;
  const freeWeekdays = SPREAD_PREFERENCE.filter((wd) => !pinned.has(wd));
  // At least one slot whenever floating days exist: a plan whose daysPerWeek is
  // already used up by its pinned days would otherwise schedule its floating
  // days literally never, which reads as a bug rather than as a cadence.
  const wanted = floatingDays.length === 0 ? 0 : Math.max(perWeek - pinned.size, 1);
  const floatingWeekdays = freeWeekdays
    .slice(0, Math.min(wanted, freeWeekdays.length))
    .sort((a, b) => mondayIndex(a) - mondayIndex(b));

  return {
    pinned,
    floatingWeekdays,
    floatingDays,
    anchor: plan.startDate ?? EPOCH_MONDAY,
  };
}

/**
 * The days scheduled on one date, in plan order. Empty means a rest day.
 * Dates before the plan's start date are never scheduled.
 */
export function scheduledDaysOn<D extends ScheduleDay>(
  plan: SchedulePlan<D>,
  isoDate: string,
  cadence: Cadence<D> = resolveCadence(plan),
): D[] {
  if (plan.days.length === 0) return [];
  if (isoDate < cadence.anchor) return [];

  const weekday = weekdayOf(isoDate);
  const result = [...(cadence.pinned.get(weekday) ?? [])];

  const slot = cadence.floatingWeekdays.indexOf(weekday);
  if (slot !== -1 && cadence.floatingDays.length > 0) {
    const weeksSinceAnchor = Math.round(
      (weekStartMs(isoDate) - weekStartMs(cadence.anchor)) / (7 * DAY_MS),
    );
    // Slots in the anchor's own week that fall before the start date never
    // happened, so they must not consume a rotation position.
    const anchorMonday = mondayIndex(weekdayOf(cadence.anchor));
    const skipped = cadence.floatingWeekdays.filter((wd) => mondayIndex(wd) < anchorMonday).length;
    const ordinal = weeksSinceAnchor * cadence.floatingWeekdays.length + slot - skipped;
    if (ordinal >= 0) {
      result.push(cadence.floatingDays[ordinal % cadence.floatingDays.length]!);
    }
  }

  return result.sort((a, b) => a.position - b.position);
}

export interface ScheduledSession<D extends ScheduleDay = ScheduleDay> {
  isoDate: string;
  days: D[];
}

/** Every scheduled date in [from, to], inclusive, skipping rest days. */
export function scheduledSessions<D extends ScheduleDay>(
  plan: SchedulePlan<D>,
  from: string,
  to: string,
): ScheduledSession<D>[] {
  if (plan.days.length === 0 || from > to) return [];
  const cadence = resolveCadence(plan);
  const sessions: ScheduledSession<D>[] = [];
  for (let iso = from; iso <= to; iso = addDays(iso, 1)) {
    const days = scheduledDaysOn(plan, iso, cadence);
    if (days.length > 0) sessions.push({ isoDate: iso, days });
  }
  return sessions;
}

/**
 * The next scheduled date on or after `from`, or null if the plan schedules
 * nothing inside `horizonDays` (a plan with no days, or one whose whole
 * rotation sits before its start date).
 */
export function nextScheduledSession<D extends ScheduleDay>(
  plan: SchedulePlan<D>,
  from: string,
  horizonDays = 60,
): ScheduledSession<D> | null {
  if (plan.days.length === 0) return null;
  const cadence = resolveCadence(plan);
  let iso = from < cadence.anchor ? cadence.anchor : from;
  for (let i = 0; i <= horizonDays; i += 1) {
    const days = scheduledDaysOn(plan, iso, cadence);
    if (days.length > 0) return { isoDate: iso, days };
    iso = addDays(iso, 1);
  }
  return null;
}
