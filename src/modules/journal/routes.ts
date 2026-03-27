import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { eq, desc } from "drizzle-orm";
import { db } from "@/db/client";
import { diaryEntries, activities, learnedFacts } from "@/db/schema";
import { processSuggestion } from "./correction";

const journalRoutes = new Hono();

// GET /entries — list all diary entries ordered by date desc
journalRoutes.get("/entries", async (c) => {
  const entries = await db
    .select({
      date: diaryEntries.date,
      content: diaryEntries.content,
      createdAt: diaryEntries.createdAt,
      updatedAt: diaryEntries.updatedAt,
    })
    .from(diaryEntries)
    .orderBy(desc(diaryEntries.date));

  return c.json({ entries });
});

// GET /entries/:date — single entry + activities for that day
journalRoutes.get("/entries/:date", async (c) => {
  const date = c.req.param("date");

  const entryRows = await db
    .select({
      date: diaryEntries.date,
      content: diaryEntries.content,
      createdAt: diaryEntries.createdAt,
      updatedAt: diaryEntries.updatedAt,
    })
    .from(diaryEntries)
    .where(eq(diaryEntries.date, date))
    .limit(1);

  if (entryRows.length === 0) {
    return c.json({ error: "Entry not found" }, 404);
  }

  const entry = entryRows[0];

  const entryActivities = await db
    .select({
      id: activities.id,
      date: activities.date,
      source: activities.source,
      type: activities.type,
      data: activities.data,
      createdAt: activities.createdAt,
    })
    .from(activities)
    .where(eq(activities.date, date));

  return c.json({ entry, activities: entryActivities });
});

// POST /entries/:date/suggest — process a suggestion/correction
journalRoutes.post(
  "/entries/:date/suggest",
  zValidator("json", z.object({ suggestion: z.string().min(1) })),
  async (c) => {
    const date = c.req.param("date");
    const { suggestion } = c.req.valid("json");

    const result = await processSuggestion(date, suggestion);

    return c.json(result);
  }
);

// GET /facts — list all learned facts ordered by createdAt desc
journalRoutes.get("/facts", async (c) => {
  const facts = await db
    .select({
      id: learnedFacts.id,
      factText: learnedFacts.factText,
      createdAt: learnedFacts.createdAt,
    })
    .from(learnedFacts)
    .orderBy(desc(learnedFacts.createdAt));

  return c.json({ facts });
});

export { journalRoutes };
