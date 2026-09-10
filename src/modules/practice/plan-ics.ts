// src/modules/practice/plan-ics.ts
// Renders a training plan's schedule as an iCalendar feed (SHAN-473, Phase 4 of
// SHAN-467). Subscribed by URL, so Google/Apple Calendar re-fetch it and pick up
// edits to the plan on their own refresh cycle.
//
// Two deliberate choices:
//   * Explicit dated VEVENTs instead of an RRULE. Pinned days would fold into a
//     weekly rule fine, but the floating rotation (D1,D2 · D3,D1 · …) does not
//     express as one, and a feed that is half rule and half exception is worse
//     than a flat list a subscriber refreshes anyway.
//   * Floating local times (no TZID, no Z). RFC 5545 §3.3.5 form 1: the event
//     happens at 07:00 wherever the reader is, which is what "my morning
//     session" means for a training plan and dodges storing a timezone.
import {
  addDays,
  scheduledSessions,
  type ScheduleDay,
  type SchedulePlan,
} from "./plan-schedule";

/** How far forward the feed enumerates. Subscribers refresh, so this rolls. */
export const ICS_HORIZON_DAYS = 120;
/** A little history so a freshly-subscribed calendar shows the current week. */
export const ICS_BACKFILL_DAYS = 14;

export interface IcsBlock {
  title: string;
  kind: string;
  mode: string;
  targetSeconds: number | null;
  targetReps: number | null;
  sets: number;
  restSeconds: number;
}

export interface IcsDay extends ScheduleDay {
  notes: string | null;
  blocks: IcsBlock[];
}

export interface IcsPlan extends SchedulePlan {
  id: string;
  title: string;
  goal: string | null;
  discipline: string | null;
  sessionTime: string | null;
  reminderMinutes: number | null;
  days: IcsDay[];
}

/** Seconds a block with no explicit time target is assumed to take per set. */
const ASSUMED_SET_SECONDS = 60;
const MIN_SESSION_SECONDS = 15 * 60;
const MAX_SESSION_SECONDS = 4 * 3600;

/**
 * Rough wall-clock length of a session: work plus the rests between sets. It is
 * an estimate by construction (a reps block has no clock), which is why the
 * event description says how long the plan thinks it is rather than pretending.
 */
export function estimateSessionSeconds(days: IcsDay[]): number {
  let seconds = 0;
  for (const day of days) {
    for (const block of day.blocks) {
      const perSet =
        block.mode === "time" && block.targetSeconds !== null
          ? block.targetSeconds
          : ASSUMED_SET_SECONDS;
      seconds += block.sets * perSet + Math.max(0, block.sets - 1) * block.restSeconds;
    }
  }
  return Math.min(MAX_SESSION_SECONDS, Math.max(MIN_SESSION_SECONDS, seconds));
}

/** RFC 5545 §3.3.11: backslash, semicolon, comma and newline are special. */
function escapeText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

/**
 * Fold to 75 octets per line (§3.1). Counted in UTF-8 bytes, not characters —
 * an emoji in a block title would otherwise push a line over the limit and some
 * parsers drop the whole property.
 */
export function foldLine(line: string): string {
  const bytes = Buffer.from(line, "utf8");
  if (bytes.length <= 75) return line;
  const parts: string[] = [];
  let start = 0;
  let limit = 75;
  while (start < bytes.length) {
    let end = Math.min(start + limit, bytes.length);
    // Never split a multi-byte sequence: continuation bytes are 10xxxxxx.
    while (end > start && end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end -= 1;
    parts.push(bytes.subarray(start, end).toString("utf8"));
    start = end;
    limit = 74; // continuation lines carry a leading space
  }
  return parts.join("\r\n ");
}

function icsDate(isoDate: string): string {
  return isoDate.replace(/-/g, "");
}

/** "2026-09-14" + "07:30" -> "20260914T073000" (floating local time). */
function icsDateTime(isoDate: string, time: string): string {
  return `${icsDate(isoDate)}T${time.replace(":", "")}00`;
}

function stampNow(now: Date): string {
  return `${now.toISOString().replace(/[-:]/g, "").slice(0, 15)}Z`;
}

function describeBlock(block: IcsBlock): string {
  const target =
    block.mode === "time"
      ? block.targetSeconds !== null
        ? `${block.targetSeconds}s`
        : "untimed"
      : block.targetReps !== null
        ? `${block.targetReps} reps`
        : "reps";
  const sets = block.sets > 1 ? `${block.sets} x ${target}` : target;
  return `${block.title} (${sets})`;
}

function sessionDescription(plan: IcsPlan, days: IcsDay[]): string {
  const lines: string[] = [];
  if (plan.goal) lines.push(plan.goal, "");
  for (const day of days) {
    lines.push(day.label);
    if (day.notes) lines.push(day.notes);
    for (const block of day.blocks) lines.push(`- ${describeBlock(block)}`);
    lines.push("");
  }
  const minutes = Math.round(estimateSessionSeconds(days) / 60);
  lines.push(`Estimated ${minutes} min.`);
  return lines.join("\n").trim();
}

/**
 * The whole feed. `today` is passed in rather than read from the clock so the
 * output is testable and the caller controls the window.
 */
export function buildPlanIcs(
  plan: IcsPlan,
  opts: { today: string; now?: Date; horizonDays?: number; backfillDays?: number } = {
    today: new Date().toISOString().slice(0, 10),
  },
): string {
  const now = opts.now ?? new Date();
  const from = addDays(opts.today, -(opts.backfillDays ?? ICS_BACKFILL_DAYS));
  const to = addDays(opts.today, opts.horizonDays ?? ICS_HORIZON_DAYS);
  const sessions = scheduledSessions(plan, from, to);
  const dtstamp = stampNow(now);

  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//shanejli.com//Training Plans//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeText(plan.title)}`,
    "REFRESH-INTERVAL;VALUE=DURATION:PT12H",
    "X-PUBLISHED-TTL:PT12H",
  ];

  for (const session of sessions) {
    const label = session.days.map((d) => d.label).join(" + ");
    const summary = plan.discipline
      ? `${plan.title} — ${label} (${plan.discipline})`
      : `${plan.title} — ${label}`;

    lines.push("BEGIN:VEVENT");
    // Stable per (plan, date): re-fetching the feed updates events in place
    // rather than duplicating them, and a dropped date disappears cleanly.
    lines.push(`UID:plan-${plan.id}-${session.isoDate}@shanejli.com`);
    lines.push(`DTSTAMP:${dtstamp}`);

    if (plan.sessionTime) {
      const seconds = estimateSessionSeconds(session.days);
      lines.push(`DTSTART:${icsDateTime(session.isoDate, plan.sessionTime)}`);
      lines.push(`DURATION:PT${Math.round(seconds / 60)}M`);
    } else {
      lines.push(`DTSTART;VALUE=DATE:${icsDate(session.isoDate)}`);
      lines.push(`DTEND;VALUE=DATE:${icsDate(addDays(session.isoDate, 1))}`);
    }

    lines.push(`SUMMARY:${escapeText(summary)}`);
    lines.push(`DESCRIPTION:${escapeText(sessionDescription(plan, session.days))}`);
    lines.push(`URL:https://shanejli.com/practice/plans/${plan.id}/today`);
    lines.push("TRANSP:TRANSPARENT");

    if (plan.reminderMinutes !== null) {
      lines.push("BEGIN:VALARM");
      lines.push("ACTION:DISPLAY");
      lines.push(`DESCRIPTION:${escapeText(summary)}`);
      lines.push(
        plan.reminderMinutes === 0
          ? "TRIGGER:PT0M"
          : `TRIGGER:-PT${plan.reminderMinutes}M`,
      );
      lines.push("END:VALARM");
    }

    lines.push("END:VEVENT");
  }

  lines.push("END:VCALENDAR");
  return `${lines.map(foldLine).join("\r\n")}\r\n`;
}
