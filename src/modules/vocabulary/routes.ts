import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { db } from "@/db/client";
import { vocabWords, vocabConnections } from "@/db/schema";
import { desc, eq, and, or, ilike, inArray, sql } from "drizzle-orm";
import { enrichWord } from "./ai-enricher";

export const vocabularyRoutes = new Hono();

// ---------------------------------------------------------------------------
// Words CRUD
// ---------------------------------------------------------------------------

const createWordSchema = z.object({
  word: z.string().min(1),
  language: z.string().min(1),
  definition: z.string().optional(),
  pronunciation: z.string().optional(),
  partOfSpeech: z.string().optional(),
  exampleSentence: z.string().optional(),
  labels: z.array(z.string()).optional(),
  autoEnrich: z.boolean().optional(),
});

// List words with optional filters
vocabularyRoutes.get("/words", async (c) => {
  try {
    const language = c.req.query("language");
    const label = c.req.query("label");
    const search = c.req.query("search");
    const limit = Math.min(Number(c.req.query("limit") || 100), 500);
    const offset = Number(c.req.query("offset") || 0);

    const conditions = [];
    if (language) conditions.push(eq(vocabWords.language, language));
    if (search) conditions.push(ilike(vocabWords.word, `%${search}%`));
    if (label) {
      conditions.push(sql`${vocabWords.labels}::jsonb @> ${JSON.stringify([label])}::jsonb`);
    }

    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const words = await db
      .select()
      .from(vocabWords)
      .where(where)
      .orderBy(desc(vocabWords.createdAt))
      .limit(limit)
      .offset(offset);

    return c.json({ words });
  } catch (err: any) {
    console.error("[vocabulary] GET /words error:", err.message, err.stack);
    return c.json({ error: err.message }, 500);
  }
});

// Get a single word with its connections
vocabularyRoutes.get("/words/:id", async (c) => {
  const id = c.req.param("id");
  const [word] = await db.select().from(vocabWords).where(eq(vocabWords.id, id));
  if (!word) return c.json({ error: "Word not found" }, 404);

  const connections = await db
    .select()
    .from(vocabConnections)
    .where(or(eq(vocabConnections.fromWordId, id), eq(vocabConnections.toWordId, id)));

  // Fetch connected words
  const connectedIds = connections.map((conn) =>
    conn.fromWordId === id ? conn.toWordId : conn.fromWordId
  );
  const connectedWords =
    connectedIds.length > 0
      ? await db.select().from(vocabWords).where(inArray(vocabWords.id, connectedIds))
      : [];

  return c.json({ word, connections, connectedWords });
});

// Create a word (optionally AI-enriched)
vocabularyRoutes.post("/words", zValidator("json", createWordSchema), async (c) => {
  const body = c.req.valid("json");

  let enriched: Partial<typeof body> = {};
  if (body.autoEnrich !== false) {
    try {
      enriched = await enrichWord(body.word, body.language);
    } catch (err) {
      console.error("[vocabulary] AI enrichment failed:", err);
    }
  }

  const [word] = await db
    .insert(vocabWords)
    .values({
      word: body.word,
      language: body.language,
      definition: body.definition || enriched.definition || null,
      pronunciation: body.pronunciation || enriched.pronunciation || null,
      partOfSpeech: body.partOfSpeech || enriched.partOfSpeech || null,
      exampleSentence: body.exampleSentence || enriched.exampleSentence || null,
      labels: body.labels || enriched.labels || [],
      aiMetadata: body.autoEnrich !== false ? { enrichedAt: new Date().toISOString() } : null,
    })
    .returning();

  return c.json({ word }, 201);
});

// Update a word
const updateWordSchema = z.object({
  word: z.string().min(1).optional(),
  language: z.string().min(1).optional(),
  definition: z.string().optional(),
  pronunciation: z.string().optional(),
  partOfSpeech: z.string().optional(),
  exampleSentence: z.string().optional(),
  labels: z.array(z.string()).optional(),
});

vocabularyRoutes.put("/words/:id", zValidator("json", updateWordSchema), async (c) => {
  const id = c.req.param("id");
  const body = c.req.valid("json");

  const [updated] = await db
    .update(vocabWords)
    .set({ ...body, updatedAt: new Date() })
    .where(eq(vocabWords.id, id))
    .returning();

  if (!updated) return c.json({ error: "Word not found" }, 404);
  return c.json({ word: updated });
});

// Delete a word (cascades connections)
vocabularyRoutes.delete("/words/:id", async (c) => {
  const id = c.req.param("id");
  const [deleted] = await db.delete(vocabWords).where(eq(vocabWords.id, id)).returning();
  if (!deleted) return c.json({ error: "Word not found" }, 404);
  return c.json({ ok: true });
});

// AI-enrich an existing word
vocabularyRoutes.post("/words/:id/enrich", async (c) => {
  const id = c.req.param("id");
  const [word] = await db.select().from(vocabWords).where(eq(vocabWords.id, id));
  if (!word) return c.json({ error: "Word not found" }, 404);

  const enriched = await enrichWord(word.word, word.language);
  const [updated] = await db
    .update(vocabWords)
    .set({
      definition: enriched.definition || word.definition,
      pronunciation: enriched.pronunciation || word.pronunciation,
      partOfSpeech: enriched.partOfSpeech || word.partOfSpeech,
      exampleSentence: enriched.exampleSentence || word.exampleSentence,
      labels: enriched.labels.length > 0 ? enriched.labels : (word.labels as string[]),
      aiMetadata: { enrichedAt: new Date().toISOString() },
      updatedAt: new Date(),
    })
    .where(eq(vocabWords.id, id))
    .returning();

  return c.json({ word: updated });
});

// ---------------------------------------------------------------------------
// Connections CRUD
// ---------------------------------------------------------------------------

const createConnectionSchema = z.object({
  fromWordId: z.string().uuid(),
  toWordId: z.string().uuid(),
  connectionType: z.enum(["synonym", "antonym", "related", "translation", "root"]),
  note: z.string().optional(),
});

vocabularyRoutes.get("/connections", async (c) => {
  const wordId = c.req.query("wordId");
  if (!wordId) return c.json({ error: "wordId required" }, 400);

  const connections = await db
    .select()
    .from(vocabConnections)
    .where(or(eq(vocabConnections.fromWordId, wordId), eq(vocabConnections.toWordId, wordId)));

  return c.json({ connections });
});

vocabularyRoutes.post("/connections", zValidator("json", createConnectionSchema), async (c) => {
  const body = c.req.valid("json");

  if (body.fromWordId === body.toWordId) {
    return c.json({ error: "Cannot connect a word to itself" }, 400);
  }

  const [connection] = await db
    .insert(vocabConnections)
    .values(body)
    .returning();

  return c.json({ connection }, 201);
});

vocabularyRoutes.delete("/connections/:id", async (c) => {
  const id = c.req.param("id");
  const [deleted] = await db.delete(vocabConnections).where(eq(vocabConnections.id, id)).returning();
  if (!deleted) return c.json({ error: "Connection not found" }, 404);
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Utility: list all distinct labels and languages
// ---------------------------------------------------------------------------

vocabularyRoutes.get("/labels", async (c) => {
  const result = await db.execute(
    sql`SELECT DISTINCT jsonb_array_elements_text(labels) AS label FROM vocab_words ORDER BY label`
  );
  const labels = (result.rows as { label: string }[]).map((r) => r.label);
  return c.json({ labels });
});

vocabularyRoutes.get("/languages", async (c) => {
  const result = await db
    .selectDistinct({ language: vocabWords.language })
    .from(vocabWords)
    .orderBy(vocabWords.language);
  return c.json({ languages: result.map((r) => r.language) });
});
