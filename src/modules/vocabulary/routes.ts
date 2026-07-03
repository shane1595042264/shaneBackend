import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { db } from "@/db/client";
import { vocabWords, vocabConnections } from "@/db/schema";
import { desc, eq, and, or, ilike, sql, inArray } from "drizzle-orm";
import { enrichWord } from "./ai-enricher";
import { requireAuth, requireScope } from "@/modules/auth/middleware";
import { createPATRateLimit } from "@/modules/shared/rate-limit";

export const vocabularyRoutes = new Hono();

// Two buckets so a noisy enrich loop can't lock out plain CRUD and vice versa.
// Limits mirror the knowledge module's 30/min on cheap writes; enrich is tighter
// because every call hits the Anthropic API (economic-DoS surface — SHAN-310).
const writesRateLimit = createPATRateLimit({
  bucket: "vocabulary-writes",
  limitPerMinute: 30,
});
const enrichRateLimit = createPATRateLimit({
  bucket: "vocabulary-enrich",
  limitPerMinute: 10,
});

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
    // Don't leak raw DB/driver error text to callers — log it, return generic.
    return c.json({ error: "Internal Server Error" }, 500);
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

// Create a word (optionally AI-enriched).
// Auth: JWT browser session OR PAT with knowledge:write. Same scope as
// knowledge module — these endpoints write the same vocabWords table.
vocabularyRoutes.post(
  "/words",
  requireAuth,
  requireScope("knowledge:write"),
  writesRateLimit,
  zValidator("json", createWordSchema),
  async (c) => {
    const body = c.req.valid("json");
    const userId = c.get("userId") as string;

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
        createdBy: userId,
      })
      .returning();

    return c.json({ word }, 201);
  }
);

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

// Ownership rule mirrors knowledge module's PUT /entries/:id: caller must be
// the creator, but legacy rows (createdBy IS NULL, predate the column on the
// vocabulary path) are editable by any authed user.
vocabularyRoutes.put(
  "/words/:id",
  requireAuth,
  requireScope("knowledge:write"),
  writesRateLimit,
  zValidator("param", uuidParamSchema),
  zValidator("json", updateWordSchema),
  async (c) => {
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const userId = c.get("userId") as string;

    const [existing] = await db
      .select({ createdBy: vocabWords.createdBy })
      .from(vocabWords)
      .where(eq(vocabWords.id, id));
    if (!existing) return c.json({ error: "Word not found" }, 404);
    if (existing.createdBy !== null && existing.createdBy !== userId) {
      return c.json({ error: "You can only edit words you created" }, 403);
    }

    const [updated] = await db
      .update(vocabWords)
      .set({ ...body, updatedAt: new Date() })
      .where(eq(vocabWords.id, id))
      .returning();

    if (!updated) return c.json({ error: "Word not found" }, 404);
    return c.json({ word: updated });
  }
);

// Delete a word (cascades connections). Same ownership rule as PUT.
vocabularyRoutes.delete(
  "/words/:id",
  requireAuth,
  requireScope("knowledge:write"),
  writesRateLimit,
  zValidator("param", uuidParamSchema),
  async (c) => {
    const { id } = c.req.valid("param");
    const userId = c.get("userId") as string;

    const [existing] = await db
      .select({ createdBy: vocabWords.createdBy })
      .from(vocabWords)
      .where(eq(vocabWords.id, id));
    if (!existing) return c.json({ error: "Word not found" }, 404);
    if (existing.createdBy !== null && existing.createdBy !== userId) {
      return c.json({ error: "You can only delete words you created" }, 403);
    }

    const [deleted] = await db.delete(vocabWords).where(eq(vocabWords.id, id)).returning();
    if (!deleted) return c.json({ error: "Word not found" }, 404);
    return c.json({ ok: true });
  }
);

// AI-enrich an existing word. Separate (tighter) rate-limit bucket because
// every call fires an Anthropic request — the economic-DoS surface SHAN-310
// closed.
vocabularyRoutes.post(
  "/words/:id/enrich",
  requireAuth,
  requireScope("knowledge:write"),
  enrichRateLimit,
  zValidator("param", uuidParamSchema),
  async (c) => {
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
      console.error("[vocabulary] enrich error:", err.message, err.stack);
      // Never leak raw err.message — it can carry Postgres/driver internals or
      // Anthropic API error bodies. Match the SHAN-343 POST /notes contract:
      // surface LLM-chain exhaustion as a safe 502 so callers can retry, and
      // fold everything else into a generic 500.
      if (err?.message?.includes("All LLM providers failed")) {
        return c.json(
          { error: "Language model providers are temporarily unavailable. Please retry." },
          502
        );
      }
      return c.json({ error: "Enrichment failed" }, 500);
    }
  }
);

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

vocabularyRoutes.post(
  "/connections",
  requireAuth,
  requireScope("knowledge:write"),
  writesRateLimit,
  zValidator("json", createConnectionSchema),
  async (c) => {
    const body = c.req.valid("json");

    if (body.fromWordId === body.toWordId) {
      return c.json({ error: "Cannot connect a word to itself" }, 400);
    }

    const existing = await db
      .select({ id: vocabWords.id })
      .from(vocabWords)
      .where(inArray(vocabWords.id, [body.fromWordId, body.toWordId]));
    const foundIds = new Set(existing.map((r) => r.id));
    if (!foundIds.has(body.fromWordId)) {
      return c.json({ error: `Word not found: ${body.fromWordId}` }, 404);
    }
    if (!foundIds.has(body.toWordId)) {
      return c.json({ error: `Word not found: ${body.toWordId}` }, 404);
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
  }
);

vocabularyRoutes.delete(
  "/connections/:id",
  requireAuth,
  requireScope("knowledge:write"),
  writesRateLimit,
  zValidator("param", uuidParamSchema),
  async (c) => {
    const { id } = c.req.valid("param");
    const [deleted] = await db.delete(vocabConnections).where(eq(vocabConnections.id, id)).returning();
    if (!deleted) return c.json({ error: "Connection not found" }, 404);
    return c.json({ ok: true });
  }
);

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
