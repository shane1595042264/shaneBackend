import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { db } from "@/db/client";
import { vocabWords, vocabConnections } from "@/db/schema";
import { desc, eq, and, or, ilike, sql, inArray } from "drizzle-orm";
import { enrichWord } from "@/modules/vocabulary/ai-enricher";
import { classifyNote, type ClassificationSource } from "./classifier";
import { postToBilibili } from "./bilibili";
import { optionalAuth, requireAuth, requireScope } from "@/modules/auth/middleware";
import { createPATRateLimit } from "@/modules/shared/rate-limit";
import {
  createComment as createKnowledgeComment,
  listForEntry as listKnowledgeComments,
  updateComment as updateKnowledgeComment,
  deleteComment as deleteKnowledgeComment,
} from "./comments-repo";

export const knowledgeRoutes = new Hono();

const uuidParamSchema = z.object({
  id: z.string().uuid("Invalid UUID"),
});

const wordsQuerySchema = z.object({
  language: z.string().optional(),
  label: z.string().optional(),
  search: z.string().optional(),
  category: z.string().optional(),
  // Filter by source.app — case-insensitive match against the jsonb source column.
  // Lets clients browse "all entries from <app>" (e.g. ?app=nibbler).
  app: z.string().min(1).max(100).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

const wordIdQuerySchema = z.object({
  wordId: z.string().uuid("Invalid UUID"),
});

// ---------------------------------------------------------------------------
// Smart Note Input — AI classifies and creates entry.
// Accepts JWT (browser) or PAT with knowledge:write scope.
// Three request shapes: { text } (legacy), { text, source }, { notes: [...] }.
// ---------------------------------------------------------------------------

const sourceObjectSchema = z
  .object({
    app: z.string().min(1).max(100).nullish(),
    book: z.string().min(1).max(255).nullish(),
    author: z.string().min(1).max(255).nullish(),
    location: z.string().min(1).max(255).nullish(),
    rawContext: z.string().min(1).max(5000).nullish(),
  })
  .strict();

const sourceInputSchema = z.union([z.string().min(1).max(100), sourceObjectSchema]);

const singleNoteSchema = z
  .object({
    text: z.string().min(1).max(5000),
    source: sourceInputSchema.optional(),
  })
  .strict();

const batchNotesSchema = z
  .object({
    notes: z.array(singleNoteSchema).min(1).max(50),
  })
  .strict();

const noteSchema = z.union([singleNoteSchema, batchNotesSchema]);

type SingleNoteInput = z.infer<typeof singleNoteSchema>;
type CallerSource = {
  app: string | null;
  book: string | null;
  author: string | null;
  location: string | null;
  rawContext: string | null;
};

function normalizeSourceInput(input: SingleNoteInput["source"]): CallerSource | null {
  if (input === undefined) return null;
  if (typeof input === "string") {
    return { app: input, book: null, author: null, location: null, rawContext: null };
  }
  return {
    app: input.app ?? null,
    book: input.book ?? null,
    author: input.author ?? null,
    location: input.location ?? null,
    rawContext: input.rawContext ?? null,
  };
}

function mergeSource(
  caller: CallerSource | null,
  classifier: ClassificationSource | null,
  originalText: string
): Record<string, string | null> | null {
  const app = caller?.app ?? classifier?.app ?? null;
  const book = caller?.book ?? classifier?.book ?? null;
  const author = caller?.author ?? classifier?.author ?? null;
  const location = caller?.location ?? classifier?.location ?? null;
  const hasAnyMeaningful = [app, book, author, location].some((v) => v !== null);
  if (!hasAnyMeaningful) return null;
  const rawContext = caller?.rawContext ?? classifier?.rawContext ?? originalText;
  return { app, book, author, location, rawContext };
}

async function ingestSingle(
  text: string,
  callerSource: CallerSource | null,
  createdBy: string | null
) {
  const classified = await classifyNote(text);
  const source = mergeSource(callerSource, classified.source, text);
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
      source,
      createdBy,
    })
    .returning();
  postToBilibili(entry).catch(() => {});
  return entry;
}

const singleRateLimit = createPATRateLimit({
  bucket: "knowledge-notes-single",
  limitPerMinute: 30,
});
const batchRateLimit = createPATRateLimit({
  bucket: "knowledge-notes-batch",
  limitPerMinute: 5,
});

knowledgeRoutes.post(
  "/notes",
  requireAuth,
  requireScope("knowledge:write"),
  zValidator("json", noteSchema),
  async (c, next) => {
    const body = c.req.valid("json");
    const limiter = "notes" in body ? batchRateLimit : singleRateLimit;
    return limiter(c, next);
  },
  async (c) => {
    const body = c.req.valid("json");
    const tokenId = c.get("tokenId") as string | null;
    const userId = (c.get("userId") as string | null) ?? null;
    const start = Date.now();

    try {
      if ("text" in body) {
        const callerSource = normalizeSourceInput(body.source);
        const entry = await ingestSingle(body.text, callerSource, userId);
        const sourceApp = (entry as any)?.source?.app ?? "manual";
        console.log(
          `[ingest] token=${tokenId ?? "jwt"} source=${sourceApp} entries=1 ms=${Date.now() - start}`
        );
        return c.json({ entries: [entry] }, 201);
      }

      // Batch path.
      const entries: unknown[] = [];
      const failures: { index: number; text: string; error: string }[] = [];
      const seen = new Set<string>();

      const classifiedResults = await Promise.allSettled(
        body.notes.map((n) => classifyNote(n.text))
      );

      for (let i = 0; i < body.notes.length; i++) {
        const note = body.notes[i];
        const result = classifiedResults[i];
        if (result.status === "rejected") {
          const err = result.reason instanceof Error ? result.reason.message : String(result.reason);
          failures.push({ index: i, text: note.text, error: err });
          continue;
        }
        const classified = result.value;
        const dedupeKey = `${classified.word}|${classified.language}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);

        const callerSource = normalizeSourceInput(note.source);
        const source = mergeSource(callerSource, classified.source, note.text);
        try {
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
                originalNote: note.text,
                classifiedCategory: classified.category,
              },
              source,
              createdBy: userId,
            })
            .returning();
          entries.push(entry);
          postToBilibili(entry).catch(() => {});
        } catch (insertErr) {
          const err = insertErr instanceof Error ? insertErr.message : String(insertErr);
          failures.push({ index: i, text: note.text, error: err });
        }
      }

      console.log(
        `[ingest] token=${tokenId ?? "jwt"} batch=${body.notes.length} ok=${entries.length} failed=${failures.length} ms=${Date.now() - start}`
      );

      if (entries.length === 0 && failures.length > 0) {
        return c.json({ entries: [], failures }, 502);
      }
      if (failures.length > 0) {
        return c.json({ entries, failures }, 207);
      }
      return c.json({ entries, failures: [] }, 201);
    } catch (err: any) {
      console.error("[knowledge] POST /notes error:", err.message, err.stack);
      // Distinguish LLM-chain exhaustion from generic backend errors so callers can
      // retry intelligently. The shared llm module throws this exact message string
      // when Anthropic, Gemini, and Groq have all failed (see shared/llm.ts:223).
      const status = err?.message?.includes("All LLM providers failed") ? 502 : 500;
      return c.json({ error: err.message }, status);
    }
  }
);

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
    const { language, label, search, category, app, limit, offset } = c.req.valid("query");

    const conditions = [];
    if (language) conditions.push(eq(vocabWords.language, language));
    if (category) conditions.push(eq(vocabWords.category, category));
    if (app) {
      // ->> extracts source.app as text; lower() on both sides keeps the match
      // case-insensitive without forcing callers to canonicalise (e.g. nibbler
      // vs Nibbler vs NIBBLER all hit the same set of rows).
      conditions.push(sql`lower(${vocabWords.source}->>'app') = lower(${app})`);
    }
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
knowledgeRoutes.post("/entries", optionalAuth, zValidator("json", createWordSchema), async (c) => {
  const body = c.req.valid("json");
  const userId = (c.get("userId") as string | null) ?? null;

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
      createdBy: userId,
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

// Delete an entry. Ownership rule: caller must be the creator. Legacy entries
// (createdBy IS NULL, predate this column) are deletable by any authed user —
// single-user app, no one else exists to lay claim.
knowledgeRoutes.delete("/entries/:id", requireAuth, zValidator("param", uuidParamSchema), async (c) => {
  const { id } = c.req.valid("param");
  const userId = c.get("userId") as string;

  const [existing] = await db
    .select({ createdBy: vocabWords.createdBy })
    .from(vocabWords)
    .where(eq(vocabWords.id, id));
  if (!existing) return c.json({ error: "Entry not found" }, 404);
  if (existing.createdBy !== null && existing.createdBy !== userId) {
    return c.json({ error: "You can only delete entries you created" }, 403);
  }

  const [deleted] = await db.delete(vocabWords).where(eq(vocabWords.id, id)).returning();
  if (!deleted) return c.json({ error: "Entry not found" }, 404);
  return c.json({ ok: true });
});

// Bulk delete. Same ownership rule as single delete. Returns per-id outcome so
// the UI can show which rows were skipped without a second round-trip.
const bulkDeleteSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(100),
});

knowledgeRoutes.post("/entries/bulk-delete", requireAuth, zValidator("json", bulkDeleteSchema), async (c) => {
  const { ids } = c.req.valid("json");
  const userId = c.get("userId") as string;

  const existing = await db
    .select({ id: vocabWords.id, createdBy: vocabWords.createdBy })
    .from(vocabWords)
    .where(inArray(vocabWords.id, ids));

  const existingIds = new Set(existing.map((r) => r.id));
  const notFound = ids.filter((id) => !existingIds.has(id));
  const owned = existing.filter((r) => r.createdBy === null || r.createdBy === userId);
  const denied = existing.filter((r) => r.createdBy !== null && r.createdBy !== userId).map((r) => r.id);
  const deletableIds = owned.map((r) => r.id);

  if (deletableIds.length === 0) {
    return c.json({ deleted: [], denied, notFound });
  }

  const deletedRows = await db
    .delete(vocabWords)
    .where(inArray(vocabWords.id, deletableIds))
    .returning({ id: vocabWords.id });

  return c.json({ deleted: deletedRows.map((r) => r.id), denied, notFound });
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

// ---------------------------------------------------------------------------
// Comments per knowledge entry (wiki-style thread, 1-level replies, no reactions)
// ---------------------------------------------------------------------------

const commentBody = z.object({
  content: z.string().min(1).max(10_000),
  parent_comment_id: z.string().uuid().optional(),
});
const commentEditBody = z.object({ content: z.string().min(1).max(10_000) });

knowledgeRoutes.get(
  "/entries/:id/comments",
  optionalAuth,
  zValidator("param", uuidParamSchema),
  async (c) => {
    const { id } = c.req.valid("param");
    const [entry] = await db
      .select({ id: vocabWords.id })
      .from(vocabWords)
      .where(eq(vocabWords.id, id))
      .limit(1);
    if (!entry) return c.json({ error: "Entry not found" }, 404);
    const comments = await listKnowledgeComments(id);
    return c.json({ comments });
  }
);

knowledgeRoutes.post(
  "/entries/:id/comments",
  requireAuth,
  requireScope("comments:write"),
  zValidator("param", uuidParamSchema),
  zValidator("json", commentBody),
  async (c) => {
    const userId = c.get("userId") as string;
    const { id } = c.req.valid("param");
    const [entry] = await db
      .select({ id: vocabWords.id })
      .from(vocabWords)
      .where(eq(vocabWords.id, id))
      .limit(1);
    if (!entry) return c.json({ error: "Entry not found" }, 404);
    const { content, parent_comment_id } = c.req.valid("json");
    const comment = await createKnowledgeComment({
      entryId: id,
      authorId: userId,
      content,
      parentCommentId: parent_comment_id,
    });
    return c.json({ comment }, 201);
  }
);

knowledgeRoutes.patch(
  "/comments/:id",
  requireAuth,
  requireScope("comments:write"),
  zValidator("param", uuidParamSchema),
  zValidator("json", commentEditBody),
  async (c) => {
    const userId = c.get("userId") as string;
    const { id } = c.req.valid("param");
    const updated = await updateKnowledgeComment(id, userId, c.req.valid("json").content);
    if (!updated) return c.json({ error: "Not found or not author" }, 404);
    return c.json({ comment: updated });
  }
);

knowledgeRoutes.delete(
  "/comments/:id",
  requireAuth,
  requireScope("comments:write"),
  zValidator("param", uuidParamSchema),
  async (c) => {
    const userId = c.get("userId") as string;
    const { id } = c.req.valid("param");
    const ok = await deleteKnowledgeComment(id, userId);
    return ok ? c.body(null, 204) : c.json({ error: "Not found or not authorized" }, 404);
  }
);
