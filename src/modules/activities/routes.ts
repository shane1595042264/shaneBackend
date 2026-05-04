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
  return c.json({ activities: rows });
});
