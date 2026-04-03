import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { eq, desc, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { diaryEntries, activities, learnedFacts } from "@/db/schema";
import { processSuggestion } from "./correction";
import { detectActivityDataIssues } from "./generator";
import type { NormalizedActivity } from "@/modules/integrations/types";

const journalRoutes = new Hono();

// GET /entries — list diary entries with pagination (default limit=20, offset=0)
journalRoutes.get("/entries", async (c) => {
  const limit = Math.max(1, Math.min(100, Number(c.req.query("limit")) || 20));
  const offset = Math.max(0, Number(c.req.query("offset")) || 0);

  const [entries, countResult] = await Promise.all([
    db
      .select({
        date: diaryEntries.date,
        content: diaryEntries.content,
        createdAt: diaryEntries.createdAt,
        updatedAt: diaryEntries.updatedAt,
      })
      .from(diaryEntries)
      .orderBy(desc(diaryEntries.date))
      .limit(limit)
      .offset(offset),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(diaryEntries),
  ]);

  const total = countResult[0].count;

  return c.json({ entries, total, limit, offset });
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

  // Detect data quality issues for debug notes
  const normalizedActs: NormalizedActivity[] = entryActivities.map((a) => ({
    date: a.date,
    source: a.source as NormalizedActivity["source"],
    type: a.type,
    data: a.data as Record<string, unknown>,
  }));
  const debugNotes = detectActivityDataIssues(normalizedActs);

  return c.json({
    entry,
    activities: entryActivities,
    debugNotes: debugNotes.length > 0 ? debugNotes : undefined,
  });
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
