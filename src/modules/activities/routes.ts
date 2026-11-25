import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@/modules/shared/zod-validator";
import { eq, asc } from "drizzle-orm";
import { db } from "@/db/client";
import { activities } from "@/db/schema";
import { isoDate } from "@/modules/shared/validators";
import { optionalAuth } from "@/modules/auth/middleware";
import { requireJournalMembership } from "@/modules/journal/access-middleware";

export const activitiesRoutes = new Hono();

const dateParam = z.object({ date: isoDate });

/**
 * When the activity itself happened, from whichever field its connector
 * writes: startTime (calendar, Strava, Maps), timestamp (GitHub, chat, GPS
 * pings) or createdAt (Twitch). Parsed rather than string-compared, because
 * calendar times carry a local offset and the rest are UTC.
 */
function occurredAt(data: unknown): number | null {
  const d = data as Record<string, unknown> | null;
  const raw = d?.startTime ?? d?.timestamp ?? d?.createdAt;
  if (typeof raw !== "string") return null;
  const t = Date.parse(raw);
  return Number.isNaN(t) ? null : t;
}

// Journal members only (SHAN-583). This is the raw feed the journal sidebar is
// built from: work calendar events, commit messages, WeChat message bodies and
// GPS visits. It was world-readable long after the journal itself went
// invite-only in SHAN-475, which made the gate on /api/journal moot.
activitiesRoutes.get("/:date", optionalAuth, requireJournalMembership, zValidator("param", dateParam), async (c) => {
  const { date } = c.req.valid("param");
  // SHAN-739: sync order, not id order. The id is a random uuid, so ordering
  // by it alone shuffled the feed and made the dedup below keep an arbitrary
  // copy. id only breaks ties within one ingest batch.
  const rows = await db
    .select({
      id: activities.id,
      date: activities.date,
      source: activities.source,
      type: activities.type,
      data: activities.data,
    })
    .from(activities)
    .where(eq(activities.date, date))
    .orderBy(asc(activities.createdAt), asc(activities.id));

  // Dedup by (source, type, data.id) when an upstream id is present, keeping
  // the most recently synced row. The DB unique constraint hashes the entire
  // `data` JSONB blob, so providers like Google Calendar that mutate fields on
  // each cron sync slip past it, and the newest copy carries the current
  // title and time of a moved meeting.
  const seen = new Set<string>();
  const deduped = rows
    .slice()
    .reverse()
    .filter((r) => {
      const upstreamId = (r.data as Record<string, unknown> | null)?.id;
      if (typeof upstreamId !== "string" || upstreamId.length === 0) return true;
      const key = `${r.source}|${r.type}|${upstreamId}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .reverse();

  // The day in sequence: the sidebar shows the first 8 rows per source.
  // Rows with no usable time go last, in sync order (sort is stable).
  const ordered = deduped
    .map((r) => ({ r, t: occurredAt(r.data) }))
    .sort((a, b) => (a.t ?? Infinity) - (b.t ?? Infinity) || 0)
    .map(({ r }) => r);

  return c.json({ activities: ordered });
});
