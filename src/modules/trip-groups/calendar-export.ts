/**
 * Itinerary → Google Calendar export (SHAN-278).
 *
 * Timed activities on dated days become 1-hour events; dated days with
 * no timed activities become a single all-day event carrying the day
 * title and untimed activities in the description. Days without dates
 * are skipped and reported. Every event is tagged with a private
 * extended property (shaneTripGroup=<groupId>) so re-export can wipe the
 * previous batch instead of duplicating.
 */
import type { TripItinerary } from "./consolidator";

export interface CalendarEventPayload {
  summary: string;
  description?: string;
  start: { dateTime?: string; date?: string; timeZone?: string };
  end: { dateTime?: string; date?: string; timeZone?: string };
  extendedProperties: { private: { shaneTripGroup: string } };
}

function nextDate(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

function plusOneHour(time: string): string {
  const [h, m] = time.split(":").map(Number);
  const eh = Math.min(23, (h ?? 0) + 1);
  return `${String(eh).padStart(2, "0")}:${String(m ?? 0).padStart(2, "0")}`;
}

export function buildEventsFromItinerary(
  groupTitle: string,
  groupId: string,
  itinerary: TripItinerary,
  timeZone: string,
): { events: CalendarEventPayload[]; skippedDays: number[] } {
  const events: CalendarEventPayload[] = [];
  const skippedDays: number[] = [];
  const tag = { private: { shaneTripGroup: groupId } };

  for (const day of itinerary.days) {
    if (!day.date) {
      skippedDays.push(day.day);
      continue;
    }
    const timed = day.activities.filter((a) => a.time);
    const untimed = day.activities.filter((a) => !a.time);

    for (const a of timed) {
      events.push({
        summary: a.title,
        description: [a.notes, `${groupTitle} — day ${day.day}`].filter(Boolean).join("\n"),
        start: { dateTime: `${day.date}T${a.time}:00`, timeZone },
        end: { dateTime: `${day.date}T${plusOneHour(a.time as string)}:00`, timeZone },
        extendedProperties: tag,
      });
    }

    // One all-day anchor per day keeps the trip visible even when nothing
    // is scheduled; it also carries the untimed activities.
    events.push({
      summary: `${groupTitle}: ${day.title}`,
      description:
        untimed.length > 0
          ? untimed.map((a) => `• ${a.title}${a.notes ? ` — ${a.notes}` : ""}`).join("\n")
          : day.location ?? undefined,
      start: { date: day.date },
      end: { date: nextDate(day.date) },
      extendedProperties: tag,
    });
  }
  return { events, skippedDays };
}

const CAL_BASE = "https://www.googleapis.com/calendar/v3/calendars/primary/events";

/** Delete every event previously exported for this group. */
export async function deletePreviousExport(accessToken: string, groupId: string): Promise<number> {
  const params = new URLSearchParams({
    privateExtendedProperty: `shaneTripGroup=${groupId}`,
    maxResults: "2500",
    showDeleted: "false",
  });
  const res = await fetch(`${CAL_BASE}?${params}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new Error(`Calendar list failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
  const data = (await res.json()) as { items?: { id: string; status?: string }[] };
  const items = (data.items ?? []).filter((i) => i.status !== "cancelled");
  for (const item of items) {
    const del = await fetch(`${CAL_BASE}/${encodeURIComponent(item.id)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!del.ok && del.status !== 404 && del.status !== 410) {
      throw new Error(`Calendar delete failed: ${del.status}`);
    }
  }
  return items.length;
}

export async function insertEvents(
  accessToken: string,
  events: CalendarEventPayload[],
): Promise<number> {
  let created = 0;
  for (const event of events) {
    const res = await fetch(CAL_BASE, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(event),
    });
    if (!res.ok) {
      throw new Error(
        `Calendar insert failed after ${created} events: ${res.status} ${(await res.text()).slice(0, 200)}`,
      );
    }
    created++;
  }
  return created;
}
