import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { db } from "@/db/client";
import { vocabWords, vocabConnections } from "@/db/schema";
import { desc, eq, and, or, ilike, sql } from "drizzle-orm";
import { enrichWord } from "@/modules/vocabulary/ai-enricher";
import { classifyNote } from "./classifier";
import { postToBilibili } from "./bilibili";

export const knowledgeRoutes = new Hono();

const uuidParamSchema = z.object({
  id: z.string().uuid("Invalid UUID"),
});

const wordsQuerySchema = z.object({
  language: z.string().optional(),
  label: z.string().optional(),
  search: z.string().optional(),
  category: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

const wordIdQuerySchema = z.object({
  wordId: z.string().uuid("Invalid UUID"),
});

// ---------------------------------------------------------------------------
// Smart Note Input — AI classifies and creates entry
// ---------------------------------------------------------------------------

const noteSchema = z.object({
  text: z.string().min(1).max(5000),
});

knowledgeRoutes.post("/notes", zValidator("json", noteSchema), async (c) => {
  const { text } = c.req.valid("json");

  try {
    const classified = await classifyNote(text);

    // Check for duplicate
    const [existing] = await db
      .select()
      .from(vocabWords)
      .where(
        and(
          eq(vocabWords.word, classified.word),
          eq(vocabWords.language, classified.language),
          eq(vocabWords.category, classified.category)
        )
      );

    if (existing) {
      return c.json(
        {
          error: `"${classified.word}" already exists in ${classified.category}/${classified.language}`,
          existingEntry: existing,
          category: classified.category,
        },
        409
      );
    }

    const [entry] = await db
      .insert(vocabWords)
      .values({
        word: classified.word,
        language: classified.language,
        category: classified.category,
        definition: classified.definition || null,
        pronunciation: classified.pronunciation || null,
        partOfSpeech: classified.partOfSpeech || null,
        exampleSentence: classified.exampleSentence || null,
        labels: classified.labels,
        aiMetadata: {
          enrichedAt: new Date().toISOString(),
          originalNote: text,
          classifiedCategory: classified.category,
        },
      })
      .returning();

    // Fire-and-forget: post to Bilibili
    postToBilibili(entry).catch(() => {});

    return c.json({ entry, category: classified.category }, 201);
  } catch (err: any) {
    console.error("[knowledge] POST /notes error:", err.message, err.stack);
    return c.json({ error: err.message }, 500);
  }
});

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

knowledgeRoutes.get("/categories", async (c) => {
  const result = await db
    .selectDistinct({ category: vocabWords.category })
    .from(vocabWords)
    .orderBy(vocabWords.category);
  return c.json({ categories: result.map((r) => r.category) });
});

// ---------------------------------------------------------------------------
// Entries CRUD (renamed from "words" but same structure)
// ---------------------------------------------------------------------------

const createWordSchema = z.object({
  word: z.string().min(1),
  language: z.string().min(1),
  category: z.string().optional().default("vocabulary"),
  definition: z.string().optional(),
  pronunciation: z.string().optional(),
  partOfSpeech: z.string().optional(),
  exampleSentence: z.string().optional(),
  labels: z.array(z.string()).optional(),
  autoEnrich: z.boolean().optional(),
});

// List entries with optional filters
knowledgeRoutes.get("/entries", zValidator("query", wordsQuerySchema), async (c) => {
  try {
    const { language, label, search, category, limit, offset } = c.req.valid("query");

    const conditions = [];
    if (language) conditions.push(eq(vocabWords.language, language));
    if (category) conditions.push(eq(vocabWords.category, category));
    if (search) {
      const pattern = `%${search}%`;
      conditions.push(
        or(
          ilike(vocabWords.word, pattern),
          ilike(vocabWords.definition, pattern),
          ilike(vocabWords.exampleSentence, pattern),
          ilike(vocabWords.pronunciation, pattern),
          ilike(vocabWords.partOfSpeech, pattern),
          ilike(vocabWords.language, pattern),
          sql`EXISTS (SELECT 1 FROM jsonb_array_elements_text(${vocabWords.labels}) AS lbl WHERE lbl ILIKE ${pattern})`
        )!
      );
    }
    if (label) {
      conditions.push(sql`${vocabWords.labels}::jsonb @> ${JSON.stringify([label])}::jsonb`);
    }

    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const [entries, countResult] = await Promise.all([
      db
        .select()
        .from(vocabWords)
        .where(where)
        .orderBy(desc(vocabWords.createdAt))
        .limit(limit)
        .offset(offset),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(vocabWords)
        .where(where),
    ]);

    const total = countResult[0]?.count ?? 0;

    return c.json({ entries, total, limit, offset });
  } catch (err: any) {
    console.error("[knowledge] GET /entries error:", err.message, err.stack);
    return c.json({ error: err.message }, 500);
  }
});

// Get a single entry with its connections
knowledgeRoutes.get("/entries/:id", zValidator("param", uuidParamSchema), async (c) => {
  const { id } = c.req.valid("param");
  const [entry] = await db.select().from(vocabWords).where(eq(vocabWords.id, id));
  if (!entry) return c.json({ error: "Entry not found" }, 404);

  const rows = await db
    .select({
      connection: vocabConnections,
      connectedEntry: vocabWords,
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
  const connectedEntries = rows.map((r) => r.connectedEntry);

  return c.json({ entry, connections, connectedEntries });
});

// Create an entry (optionally AI-enriched, for vocab category)
knowledgeRoutes.post("/entries", zValidator("json", createWordSchema), async (c) => {
  const body = c.req.valid("json");

  const [existing] = await db
    .select()
    .from(vocabWords)
    .where(
      and(
        eq(vocabWords.word, body.word),
        eq(vocabWords.language, body.language),
        eq(vocabWords.category, body.category ?? "vocabulary")
      )
    );

  if (existing) {
    return c.json(
      { error: `"${body.word}" already exists in ${body.category}/${body.language}`, existingEntry: existing },
      409
    );
  }

  let enriched: Partial<typeof body> = {};
  if (body.autoEnrich !== false && body.category === "vocabulary") {
    try {
      enriched = await enrichWord(body.word, body.language);
    } catch (err) {
      console.error("[knowledge] AI enrichment failed:", err);
    }
  }

  const [entry] = await db
    .insert(vocabWords)
    .values({
      word: body.word,
      language: body.language,
      category: body.category ?? "vocabulary",
      definition: body.definition || enriched.definition || null,
      pronunciation: body.pronunciation || enriched.pronunciation || null,
      partOfSpeech: body.partOfSpeech || enriched.partOfSpeech || null,
      exampleSentence: body.exampleSentence || enriched.exampleSentence || null,
      labels: body.labels || enriched.labels || [],
      aiMetadata: body.autoEnrich !== false ? { enrichedAt: new Date().toISOString() } : null,
    })
    .returning();

  // Fire-and-forget: post to Bilibili
  postToBilibili(entry).catch(() => {});

  return c.json({ entry }, 201);
});

// Update an entry
const updateWordSchema = z.object({
  word: z.string().min(1).optional(),
  language: z.string().min(1).optional(),
  category: z.string().optional(),
  definition: z.string().optional(),
  pronunciation: z.string().optional(),
  partOfSpeech: z.string().optional(),
  exampleSentence: z.string().optional(),
  labels: z.array(z.string()).optional(),
});

knowledgeRoutes.put("/entries/:id", zValidator("param", uuidParamSchema), zValidator("json", updateWordSchema), async (c) => {
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");

  const [updated] = await db
    .update(vocabWords)
    .set({ ...body, updatedAt: new Date() })
    .where(eq(vocabWords.id, id))
    .returning();

  if (!updated) return c.json({ error: "Entry not found" }, 404);
  return c.json({ entry: updated });
});

// Delete an entry
knowledgeRoutes.delete("/entries/:id", zValidator("param", uuidParamSchema), async (c) => {
  const { id } = c.req.valid("param");
  const [deleted] = await db.delete(vocabWords).where(eq(vocabWords.id, id)).returning();
  if (!deleted) return c.json({ error: "Entry not found" }, 404);
  return c.json({ ok: true });
});

// AI-enrich an existing entry
knowledgeRoutes.post("/entries/:id/enrich", zValidator("param", uuidParamSchema), async (c) => {
  const { id } = c.req.valid("param");
  const [entry] = await db.select().from(vocabWords).where(eq(vocabWords.id, id));
  if (!entry) return c.json({ error: "Entry not found" }, 404);

  try {
    const enriched = await enrichWord(entry.word, entry.language);
    const [updated] = await db
      .update(vocabWords)
      .set({
        definition: enriched.definition || entry.definition,
        pronunciation: enriched.pronunciation || entry.pronunciation,
        partOfSpeech: enriched.partOfSpeech || entry.partOfSpeech,
        exampleSentence: enriched.exampleSentence || entry.exampleSentence,
        labels: enriched.labels.length > 0 ? enriched.labels : (entry.labels as string[]),
        aiMetadata: { enrichedAt: new Date().toISOString() },
        updatedAt: new Date(),
      })
      .where(eq(vocabWords.id, id))
      .returning();

    return c.json({ entry: updated });
  } catch (err: any) {
    console.error("[knowledge] enrich error:", err.message);
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

knowledgeRoutes.get("/connections", zValidator("query", wordIdQuerySchema), async (c) => {
  const { wordId } = c.req.valid("query");

  const connections = await db
    .select()
    .from(vocabConnections)
    .where(or(eq(vocabConnections.fromWordId, wordId), eq(vocabConnections.toWordId, wordId)));

  return c.json({ connections });
});

knowledgeRoutes.post("/connections", zValidator("json", createConnectionSchema), async (c) => {
  const body = c.req.valid("json");

  if (body.fromWordId === body.toWordId) {
    return c.json({ error: "Cannot connect an entry to itself" }, 400);
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

knowledgeRoutes.delete("/connections/:id", zValidator("param", uuidParamSchema), async (c) => {
  const { id } = c.req.valid("param");
  const [deleted] = await db.delete(vocabConnections).where(eq(vocabConnections.id, id)).returning();
  if (!deleted) return c.json({ error: "Connection not found" }, 404);
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Utility: list all distinct labels and languages
// ---------------------------------------------------------------------------

knowledgeRoutes.get("/labels", async (c) => {
  const result = await db.execute(
    sql`SELECT DISTINCT jsonb_array_elements_text(labels) AS label FROM vocab_words ORDER BY label`
  );
  const labels = (result.rows as { label: string }[]).map((r) => r.label);
  return c.json({ labels });
});

knowledgeRoutes.get("/languages", async (c) => {
  const result = await db
    .selectDistinct({ language: vocabWords.language })
    .from(vocabWords)
    .orderBy(vocabWords.language);
  return c.json({ languages: result.map((r) => r.language) });
});
