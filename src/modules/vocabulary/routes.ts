import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { db } from "@/db/client";
import { vocabWords, vocabConnections } from "@/db/schema";
import { desc, eq, and, or, ilike, sql } from "drizzle-orm";
import { enrichWord } from "./ai-enricher";

export const vocabularyRoutes = new Hono();

const uuidParamSchema = z.object({
  id: z.string().uuid("Invalid UUID"),
});

const wordsQuerySchema = z.object({
  language: z.string().optional(),
  label: z.string().optional(),
  search: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

const wordIdQuerySchema = z.object({
  wordId: z.string().uuid("Invalid UUID"),
});

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
vocabularyRoutes.get("/words", zValidator("query", wordsQuerySchema), async (c) => {
  try {
    const { language, label, search, limit, offset } = c.req.valid("query");

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
vocabularyRoutes.get("/words/:id", zValidator("param", uuidParamSchema), async (c) => {
  const { id } = c.req.valid("param");
  const [word] = await db.select().from(vocabWords).where(eq(vocabWords.id, id));
  if (!word) return c.json({ error: "Word not found" }, 404);

  // Single JOIN query: fetch connections with their connected words
  const rows = await db
    .select({
      connection: vocabConnections,
      connectedWord: vocabWords,
    })
    .from(vocabConnections)
    .innerJoin(
      vocabWords,
      sql`${vocabWords.id} = CASE
        WHEN ${vocabConnections.fromWordId} = ${id} THEN ${vocabConnections.toWordId}
        ELSE ${vocabConnections.fromWordId}
      END`
    )
    .where(or(eq(vocabConnections.fromWordId, id), eq(vocabConnections.toWordId, id)));

  const connections = rows.map((r) => r.connection);
  const connectedWords = rows.map((r) => r.connectedWord);

  return c.json({ word, connections, connectedWords });
});

// Create a word (optionally AI-enriched)
vocabularyRoutes.post("/words", zValidator("json", createWordSchema), async (c) => {
  const body = c.req.valid("json");

  // Check for duplicate word+language
  const [existing] = await db
    .select()
    .from(vocabWords)
    .where(and(eq(vocabWords.word, body.word), eq(vocabWords.language, body.language)));

  if (existing) {
    return c.json(
      { error: `"${body.word}" already exists in ${body.language}`, existingWord: existing },
      409
    );
  }

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

vocabularyRoutes.put("/words/:id", zValidator("param", uuidParamSchema), zValidator("json", updateWordSchema), async (c) => {
  const { id } = c.req.valid("param");
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
vocabularyRoutes.delete("/words/:id", zValidator("param", uuidParamSchema), async (c) => {
  const { id } = c.req.valid("param");
  const [deleted] = await db.delete(vocabWords).where(eq(vocabWords.id, id)).returning();
  if (!deleted) return c.json({ error: "Word not found" }, 404);
  return c.json({ ok: true });
});

// AI-enrich an existing word
vocabularyRoutes.post("/words/:id/enrich", zValidator("param", uuidParamSchema), async (c) => {
  const { id } = c.req.valid("param");
  const [word] = await db.select().from(vocabWords).where(eq(vocabWords.id, id));
  if (!word) return c.json({ error: "Word not found" }, 404);

  try {
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
  } catch (err: any) {
    console.error("[vocabulary] enrich error:", err.message);
    return c.json({ error: `Enrichment failed: ${err.message}` }, 500);
  }
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

vocabularyRoutes.get("/connections", zValidator("query", wordIdQuerySchema), async (c) => {
  const { wordId } = c.req.valid("query");

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

  try {
    const [connection] = await db
      .insert(vocabConnections)
      .values(body)
      .returning();

    return c.json({ connection }, 201);
  } catch (err: any) {
    if (err.code === "23505") {
      return c.json({ error: "This connection already exists" }, 409);
    }
    throw err;
  }
});

vocabularyRoutes.delete("/connections/:id", zValidator("param", uuidParamSchema), async (c) => {
  const { id } = c.req.valid("param");
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
