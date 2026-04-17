import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { eq, desc, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { diaryEntries, activities, learnedFacts } from "@/db/schema";
import { generateCorrection, finalizeSuggestion } from "./correction";
import { detectActivityDataIssues, regenerateDailyEntry } from "./generator";
import type { NormalizedActivity } from "@/modules/integrations/types";

const journalRoutes = new Hono();

const dateParamSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD format"),
});

const paginationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).default(20).transform((v) => Math.min(v, 100)),
  offset: z.coerce.number().int().min(0).default(0),
});

// GET /entries — list diary entries with pagination (default limit=20, offset=0)
journalRoutes.get("/entries", zValidator("query", paginationQuerySchema), async (c) => {
  const { limit, offset } = c.req.valid("query");

  const [entries, countResult] = await Promise.all([
    db
      .select({
        id: diaryEntries.id,
        date: diaryEntries.date,
        content: diaryEntries.content,
        voiceProfileVersion: diaryEntries.voiceProfileVersion,
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
journalRoutes.get("/entries/:date", zValidator("param", dateParamSchema), async (c) => {
  const { date } = c.req.valid("param");

  const entryRows = await db
    .select({
      id: diaryEntries.id,
      date: diaryEntries.date,
      content: diaryEntries.content,
      voiceProfileVersion: diaryEntries.voiceProfileVersion,
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
  zValidator("param", dateParamSchema),
  zValidator("json", z.object({ suggestion: z.string().min(1) })),
  async (c) => {
    const { date } = c.req.valid("param");
    const { suggestion } = c.req.valid("json");

    try {
      // Phase 1: Generate corrected content (synchronous — user waits for this)
      const { correctedContent, entryId, originalContent } =
        await generateCorrection(date, suggestion);

      // Phase 2: Extract facts, update DB, store learned facts (fire-and-forget)
      // Runs in background so the user gets the corrected content immediately
      finalizeSuggestion(entryId, suggestion, originalContent, correctedContent)
        .then((facts) => console.log(`[suggest] Phase 2 complete for ${date}: ${facts.length} facts extracted`))
        .catch((err) => console.error(`[suggest] Phase 2 failed for ${date}:`, (err as Error).message));

      return c.json({ correctedContent, extractedFacts: [] });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Unknown error";
      console.error(`[suggest] Failed for ${date}:`, message);

      if (message.includes("No diary entry found")) {
        return c.json({ error: message }, 404);
      }

      return c.json({ error: "Failed to process suggestion. Please try again." }, 500);
    }
  }
);

// POST /entries/:date/regenerate — re-generate entry using Claude only (no fallback)
journalRoutes.post(
  "/entries/:date/regenerate",
  zValidator("param", dateParamSchema),
  async (c) => {
    const { date } = c.req.valid("param");

    try {
      const result = await regenerateDailyEntry(date);
      return c.json({
        content: result.content,
        modelUsed: result.modelUsed,
        voiceProfileVersion: result.voiceProfileVersion,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Unknown error";
      console.error(`[regenerate] Failed for ${date}:`, message);
      return c.json(
        { error: "Regeneration failed. Claude API may be unavailable.", detail: message },
        502
      );
    }
  }
);

// GET /facts — list learned facts with pagination (default limit=50)
const factsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).default(50).transform((v) => Math.min(v, 200)),
  offset: z.coerce.number().int().min(0).default(0),
});

journalRoutes.get("/facts", zValidator("query", factsQuerySchema), async (c) => {
  const { limit, offset } = c.req.valid("query");

  const [facts, countResult] = await Promise.all([
    db
      .select({
        id: learnedFacts.id,
        factText: learnedFacts.factText,
        createdAt: learnedFacts.createdAt,
      })
      .from(learnedFacts)
      .orderBy(desc(learnedFacts.createdAt))
      .limit(limit)
      .offset(offset),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(learnedFacts),
  ]);

  const total = countResult[0].count;

  return c.json({ facts, total, limit, offset });
});

// DELETE /facts/:id — remove a learned fact
journalRoutes.delete(
  "/facts/:id",
  zValidator("param", z.object({ id: z.string().uuid("Invalid fact ID") })),
  async (c) => {
    const { id } = c.req.valid("param");
    const [deleted] = await db
      .delete(learnedFacts)
      .where(eq(learnedFacts.id, id))
      .returning({ id: learnedFacts.id });

    if (!deleted) {
      return c.json({ error: "Fact not found" }, 404);
    }

    return c.json({ ok: true });
  }
);

// GET /feed — Atom XML feed of journal entries
journalRoutes.get("/feed", async (c) => {
  const entries = await db
    .select({
      date: diaryEntries.date,
      content: diaryEntries.content,
      updatedAt: diaryEntries.updatedAt,
    })
    .from(diaryEntries)
    .orderBy(desc(diaryEntries.date))
    .limit(20);

  const siteUrl = "https://shanejli.com";
  const feedUpdated = entries.length > 0
    ? new Date(entries[0].updatedAt).toISOString()
    : new Date().toISOString();

  const atomEntries = entries.map((entry) => {
    const plainContent = stripDataMarkers(entry.content);
    const snippet = plainContent.length > 200
      ? plainContent.slice(0, 200).trimEnd() + "..."
      : plainContent;
    const dateFormatted = new Date(entry.date + "T00:00:00Z").toLocaleDateString("en-US", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    });
    const updated = new Date(entry.updatedAt).toISOString();
    const entryUrl = `${siteUrl}/journal/${entry.date}`;

    // Escape XML special chars in content
    const escapedContent = escapeXml(plainContent);

    return `  <entry>
    <title>${escapeXml(dateFormatted)}</title>
    <link href="${entryUrl}" rel="alternate" type="text/html"/>
    <id>${entryUrl}</id>
    <updated>${updated}</updated>
    <summary>${escapeXml(snippet)}</summary>
    <content type="html">${escapedContent.split("\n").filter(Boolean).map((p) => `&lt;p&gt;${p}&lt;/p&gt;`).join("")}</content>
  </entry>`;
  });

  const xml = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Shane's Journal</title>
  <subtitle>Daily reflections from Shane's Periodic Table of Life</subtitle>
  <link href="${siteUrl}/journal" rel="alternate" type="text/html"/>
  <link href="${siteUrl}/api/journal/feed" rel="self" type="application/atom+xml"/>
  <id>${siteUrl}/journal</id>
  <updated>${feedUpdated}</updated>
  <author>
    <name>Shane</name>
  </author>
${atomEntries.join("\n")}
</feed>`;

  c.header("Content-Type", "application/atom+xml; charset=utf-8");
  c.header("Cache-Control", "public, max-age=3600");
  return c.body(xml);
});

/** Strip [[data:TYPE|DISPLAY|JSON]] markers, keeping only the display text. */
function stripDataMarkers(text: string): string {
  return text.replace(/\[\[data:[^|]+\|([^|]+)\|[\s\S]*?\]\]/g, "$1");
}

/** Escape XML special characters. */
function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export { journalRoutes };
