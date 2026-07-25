import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { practiceSessions, vocabReviews, vocabWords } from "@/db/schema";
import type { Session } from "./sessions-repo";
import { generateVocabSession, type VocabCard } from "./vocab-generator";

export async function createVocabSession(input: {
  userId: string;
  locationId: string | null;
  locationName: string;
  locationNormalized: string;
  nItemsRequested: number;
}): Promise<Session> {
  const [session] = await db
    .insert(practiceSessions)
    .values({
      userId: input.userId,
      mode: "vocab",
      categoryFilter: "vocabulary",
      nItemsRequested: input.nItemsRequested,
      locationId: input.locationId,
      locationName: input.locationName,
      locationNormalized: input.locationNormalized,
    })
    .returning();
  return session as Session;
}

/**
 * Load a vocab session and (re)compute its card queue. The queue is derived on
 * every load rather than snapshotted, so a mid-session reload resumes with the
 * currently-due words + a fresh new-word top-up. Grades commit per card, so no
 * progress is lost. Returns null if the session isn't the user's vocab session.
 */
export async function getVocabSession(
  id: string,
  userId: string,
): Promise<{ session: Session; cards: VocabCard[] } | null> {
  const [row] = await db
    .select()
    .from(practiceSessions)
    .where(and(eq(practiceSessions.id, id), eq(practiceSessions.userId, userId)))
    .limit(1);
  const session = row as Session | undefined;
  if (!session || session.mode !== "vocab" || !session.locationNormalized) return null;
  const cards = await generateVocabSession({
    userId,
    locationNormalized: session.locationNormalized,
    n: session.nItemsRequested,
  });
  return { session, cards };
}

export interface VocabSummary {
  reviewed: number;
  remembered: number;
  forgot: number;
  leveledUp: number;
  newlyMemorized: { word: string; location: string | null }[];
}

export async function vocabSessionSummary(
  id: string,
  userId: string,
): Promise<VocabSummary | null> {
  const [row] = await db
    .select()
    .from(practiceSessions)
    .where(and(eq(practiceSessions.id, id), eq(practiceSessions.userId, userId)))
    .limit(1);
  const s = row as Session | undefined;
  if (!s || s.mode !== "vocab") return null;

  const rows = (await db
    .select({
      grade: vocabReviews.grade,
      levelBefore: vocabReviews.levelBefore,
      levelAfter: vocabReviews.levelAfter,
      word: vocabWords.word,
    })
    .from(vocabReviews)
    .innerJoin(vocabWords, eq(vocabWords.id, vocabReviews.itemId))
    .where(eq(vocabReviews.sessionId, id))
    .orderBy(desc(vocabReviews.reviewedAt))) as Array<{
    grade: string;
    levelBefore: number;
    levelAfter: number;
    word: string;
  }>;

  const reviewed = rows.length;
  const remembered = rows.filter((r) => r.grade === "remember").length;
  const forgot = reviewed - remembered;
  const leveledUp = rows.filter((r) => r.levelAfter > r.levelBefore).length;

  // "Newly memorized this session" = a review that climbed to the memorize level
  // (default 3). De-duped by word. (Assumes the default vocabLevelToMemorize=3;
  // documented in the spec's non-goals.)
  const memorizedWords = new Map<string, { word: string; location: string | null }>();
  for (const r of rows) {
    if (r.levelAfter > r.levelBefore && r.levelAfter >= 3) {
      memorizedWords.set(r.word, { word: r.word, location: s.locationName });
    }
  }

  return { reviewed, remembered, forgot, leveledUp, newlyMemorized: [...memorizedWords.values()] };
}
