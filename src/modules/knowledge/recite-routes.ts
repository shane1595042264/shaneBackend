import { Hono } from "hono";
import { z } from "zod";
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { vocabWords } from "@/db/schema";
import { requireAuth, requireScope } from "@/modules/auth/middleware";
import { createPATRateLimit } from "@/modules/shared/rate-limit";
import { trimmedRequired } from "@/modules/shared/validators";
import { zValidator } from "@/modules/shared/zod-validator";
import { upsertLocation } from "@/modules/practice/locations-repo";
import { applyLocationDelta, computeLongTermMemorized } from "./memorization";
import { buildHints, judgeRecital } from "./recite";

/**
 * SHAN-575: recite. Mounted at the root of knowledgeRoutes, so the paths below
 * are /api/knowledge/recite/deck and /api/knowledge/entries/:id/recite.
 *
 * Recite works on the caller's own cards: the ones they created plus the
 * ownerless legacy rows, which is exactly the set PUT /entries/:id lets them
 * write to. A pass writes to the card, so a deck that offered anything else
 * would hand out cards whose pass could only 403.
 */
export const reciteRoutes = new Hono();

/** A deck is one sitting. Prod holds 62 cards; this only bounds the response. */
const MAX_DECK = 500;

const deckRateLimit = createPATRateLimit({ bucket: "knowledge-recite-deck", limitPerMinute: 30 });
// Every attempt can be a model call, so a PAT gets a budget; a person typing
// answers will not come near it. JWTs pass uncounted, as everywhere.
const attemptRateLimit = createPATRateLimit({ bucket: "knowledge-recite-attempts", limitPerMinute: 60 });

const deckSchema = z
  .object({
    location: trimmedRequired(120),
    categories: z.array(trimmedRequired(100)).max(50).optional(),
  })
  .strict();

const attemptSchema = z
  .object({
    location: trimmedRequired(120),
    answer: trimmedRequired(5000),
    /** 1-based attempt number for this card in this sitting; picks the hint a miss reveals. */
    attempt: z.number().int().min(1).max(50).default(1),
  })
  .strict();

const idParam = z.object({ id: z.string().uuid("Invalid UUID") });

/** Built per request, never at module scope: the route tests mock @/db/schema partially. */
function ownedBy(userId: string) {
  return or(isNull(vocabWords.createdBy), eq(vocabWords.createdBy, userId));
}

function notMemorizedAt(location: string) {
  // Same case-insensitive membership test GET /entries?excludeLocation= uses,
  // so the deck and the browse filter can never disagree about a card.
  return sql`NOT EXISTS (
    SELECT 1
    FROM jsonb_array_elements_text(coalesce(${vocabWords.memorizationLocations}, '[]'::jsonb)) AS loc
    WHERE lower(loc) = lower(${location})
  )`;
}

function hasDefinition() {
  // A card with nothing to recite cannot be passed, so it never enters a deck.
  return sql`coalesce(trim(${vocabWords.definition}), '') <> ''`;
}

// The deck for one place. Saving the place is part of asking for its deck: the
// recite page offers your saved locations, and a name you type that is not one
// of them becomes one here (practice_locations, the same list practice mode
// uses). Answering "where are you" is the whole act of creating it.
reciteRoutes.post(
  "/recite/deck",
  requireAuth,
  requireScope("knowledge:write"),
  deckRateLimit,
  zValidator("json", deckSchema),
  async (c) => {
    const userId = c.get("userId") as string;
    const { location, categories } = c.req.valid("json");

    const saved = await upsertLocation(userId, location);
    if (!saved) return c.json({ error: "Location is blank after normalization" }, 400);

    const base = and(ownedBy(userId), hasDefinition(), notMemorizedAt(saved.name));
    const where = categories?.length ? and(base, inArray(vocabWords.category, categories)) : base;

    const [cards, byCategory] = await Promise.all([
      // random() is fine at this size; the deck is shuffled once per sitting,
      // and the client walks it in the order it arrives.
      db.select().from(vocabWords).where(where).orderBy(sql`random()`).limit(MAX_DECK),
      db
        .select({
          category: vocabWords.category,
          total: sql<number>`count(*)::int`,
          remaining: sql<number>`(count(*) filter (where ${notMemorizedAt(saved.name)}))::int`,
        })
        .from(vocabWords)
        .where(and(ownedBy(userId), hasDefinition()))
        .groupBy(vocabWords.category)
        .orderBy(vocabWords.category),
    ]);

    return c.json({
      location: { id: saved.id, name: saved.name },
      cards,
      total: cards.length,
      categories: byCategory,
    });
  }
);

// Grade one recital. A pass records the place on the card; a miss returns the
// next hint. Nothing is written on a miss.
reciteRoutes.post(
  "/entries/:id/recite",
  requireAuth,
  requireScope("knowledge:write"),
  attemptRateLimit,
  zValidator("param", idParam),
  zValidator("json", attemptSchema),
  async (c) => {
    const { id } = c.req.valid("param");
    const userId = c.get("userId") as string;
    const { location, answer, attempt } = c.req.valid("json");

    const [card] = await db.select().from(vocabWords).where(eq(vocabWords.id, id));
    if (!card) return c.json({ error: "Entry not found" }, 404);
    if (card.createdBy !== null && card.createdBy !== userId) {
      return c.json({ error: "You can only recite entries you created" }, 403);
    }
    const reference = card.definition?.trim();
    if (!reference) return c.json({ error: "This entry has no definition to recite" }, 422);

    let verdict;
    try {
      verdict = await judgeRecital({ prompt: card.word, reference, recital: answer });
    } catch (err) {
      console.error("[recite] grading failed with no fallback left:", (err as Error).message);
      return c.json({ error: "Grading is unavailable right now. Try again in a moment." }, 503);
    }

    if (!verdict.correct) {
      const hints = buildHints(card);
      const hintNumber = Math.min(attempt, hints.length);
      return c.json({
        ...verdict,
        hint: hints[hintNumber - 1] ?? null,
        hintNumber,
        hintsTotal: hints.length,
      });
    }

    // Canonical casing: typing "MIRRA" at a saved "Mirra" records "Mirra".
    const saved = await upsertLocation(userId, location);
    if (!saved) return c.json({ error: "Location is blank after normalization" }, 400);

    const [updated] = await db.transaction(async (tx) => {
      // FOR UPDATE, as in PUT /entries/:id: practice's vocab SRS appends to the
      // same array under the same lock, so neither write can drop the other's.
      const [row] = await tx
        .select({ locations: vocabWords.memorizationLocations })
        .from(vocabWords)
        .where(eq(vocabWords.id, id))
        .for("update");
      if (!row) return [];
      const locations = applyLocationDelta(row.locations, [saved.name]);
      return tx
        .update(vocabWords)
        .set({
          memorizationLocations: locations,
          longTermMemorized: computeLongTermMemorized(locations),
          updatedAt: new Date(),
        })
        .where(eq(vocabWords.id, id))
        .returning();
    });
    if (!updated) return c.json({ error: "Entry not found" }, 404);

    return c.json({ ...verdict, memorizedAt: saved.name, entry: updated });
  }
);
