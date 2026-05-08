import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { eq, asc } from "drizzle-orm";
import { db } from "@/db/client";
import { activities } from "@/db/schema";

export const activitiesRoutes = new Hono();

const dateParam = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD"),
});

activitiesRoutes.get("/:date", zValidator("param", dateParam), async (c) => {
  const { date } = c.req.valid("param");
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
    .orderBy(asc(activities.id));

  // Dedup by (source, type, data.id) when an upstream id is present, keeping
  // the first-seen row. The DB unique constraint hashes the entire `data`
  // JSONB blob, so providers like Google Calendar that mutate side fields
  // (e.g. location attendee list) on each cron sync slip past it.
  const seen = new Set<string>();
  const deduped = rows.filter((r) => {
    const upstreamId = (r.data as Record<string, unknown> | null)?.id;
    if (typeof upstreamId !== "string" || upstreamId.length === 0) return true;
    const key = `${r.source}|${r.type}|${upstreamId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return c.json({ activities: deduped });
});
