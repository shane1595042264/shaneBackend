import { and, asc, desc, eq, inArray, lt, sql } from "drizzle-orm";
import { db } from "@/db/client";
import {
  scoreboardGames,
  scoreboardMatchPlayers,
  scoreboardMatches,
  scoreboardPlayers,
} from "@/db/schema";

// Palette tokens shared with the frontend (components/scoreboard/palette.ts).
// Auto-assignment cycles this list by row count so consecutive games and
// players land on different hues without any bookkeeping.
export const SCOREBOARD_COLORS = [
  "amber", "sky", "emerald", "fuchsia", "rose",
  "violet", "lime", "cyan", "orange", "teal",
] as const;
export type ScoreboardColor = (typeof SCOREBOARD_COLORS)[number];

export interface ScoreboardGameRow {
  id: string;
  userId: string;
  name: string;
  description: string | null;
  rules: string | null;
  iconPath: string;
  iconViewBox: string;
  iconSlug: string;
  color: string;
  createdAt: Date;
  updatedAt: Date;
}
export interface ScoreboardPlayerRow {
  id: string;
  userId: string;
  name: string;
  color: string;
  createdAt: Date;
}
export interface ScoreboardMatchRow {
  id: string;
  userId: string;
  gameId: string;
  location: string | null;
  status: string;
  winnerPlayerId: string | null;
  playedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}
export interface MatchPlayerJoinedRow {
  matchId: string;
  playerId: string;
  name: string;
  color: string;
  score: number;
  position: number;
}

export async function listGames(): Promise<ScoreboardGameRow[]> {
  const rows = await db
    .select()
    .from(scoreboardGames)
    .orderBy(asc(scoreboardGames.createdAt));
  return rows as ScoreboardGameRow[];
}

// Per-(game, winner) final-match counts. Finals always carry a winner
// (finish requires one; player delete is blocked while matches exist),
// so summing wins per game also yields the game's final-match count.
export async function gameWinStats(): Promise<
  { gameId: string; playerId: string | null; wins: number }[]
> {
  const rows = await db
    .select({
      gameId: scoreboardMatches.gameId,
      playerId: scoreboardMatches.winnerPlayerId,
      wins: sql<number>`count(*)::int`,
    })
    .from(scoreboardMatches)
    .where(eq(scoreboardMatches.status, "final"))
    .groupBy(scoreboardMatches.gameId, scoreboardMatches.winnerPlayerId);
  return rows as { gameId: string; playerId: string | null; wins: number }[];
}

async function nextColor(
  table: typeof scoreboardGames | typeof scoreboardPlayers,
): Promise<string> {
  const rows = await db.select({ n: sql<number>`count(*)::int` }).from(table);
  const n = Number((rows[0] as { n?: number } | undefined)?.n ?? 0);
  return SCOREBOARD_COLORS[n % SCOREBOARD_COLORS.length];
}

export async function createGame(input: {
  userId: string;
  name: string;
  description?: string | null;
  rules?: string | null;
  iconPath: string;
  iconViewBox: string;
  iconSlug: string;
  color?: string;
}): Promise<ScoreboardGameRow> {
  const color = input.color ?? (await nextColor(scoreboardGames));
  const [row] = await db
    .insert(scoreboardGames)
    .values({
      userId: input.userId,
      name: input.name,
      description: input.description ?? null,
      rules: input.rules ?? null,
      iconPath: input.iconPath,
      iconViewBox: input.iconViewBox,
      iconSlug: input.iconSlug,
      color,
    })
    .returning();
  return row as ScoreboardGameRow;
}

export async function updateGame(
  id: string,
  userId: string,
  patch: {
    name?: string;
    description?: string | null;
    rules?: string | null;
    color?: string;
    icon?: { path: string; viewBox: string; slug: string };
  },
): Promise<ScoreboardGameRow | null> {
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.description !== undefined) set.description = patch.description;
  if (patch.rules !== undefined) set.rules = patch.rules;
  if (patch.color !== undefined) set.color = patch.color;
  if (patch.icon !== undefined) {
    set.iconPath = patch.icon.path;
    set.iconViewBox = patch.icon.viewBox;
    set.iconSlug = patch.icon.slug;
  }
  const [row] = await db
    .update(scoreboardGames)
    .set(set)
    .where(and(eq(scoreboardGames.id, id), eq(scoreboardGames.userId, userId)))
    .returning();
  return (row as ScoreboardGameRow | undefined) ?? null;
}

export async function deleteGame(id: string, userId: string): Promise<boolean> {
  const result = await db
    .delete(scoreboardGames)
    .where(and(eq(scoreboardGames.id, id), eq(scoreboardGames.userId, userId)))
    .returning({ id: scoreboardGames.id });
  return result.length > 0;
}

export async function listPlayers(): Promise<ScoreboardPlayerRow[]> {
  const rows = await db
    .select()
    .from(scoreboardPlayers)
    .orderBy(asc(scoreboardPlayers.createdAt));
  return rows as ScoreboardPlayerRow[];
}

export async function createPlayer(input: {
  userId: string;
  name: string;
  color?: string;
}): Promise<ScoreboardPlayerRow> {
  const color = input.color ?? (await nextColor(scoreboardPlayers));
  const [row] = await db
    .insert(scoreboardPlayers)
    .values({ userId: input.userId, name: input.name, color })
    .returning();
  return row as ScoreboardPlayerRow;
}

export async function updatePlayer(
  id: string,
  userId: string,
  patch: { name?: string; color?: string },
): Promise<ScoreboardPlayerRow | null> {
  const set: Record<string, unknown> = {};
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.color !== undefined) set.color = patch.color;
  const [row] = await db
    .update(scoreboardPlayers)
    .set(set)
    .where(and(eq(scoreboardPlayers.id, id), eq(scoreboardPlayers.userId, userId)))
    .returning();
  return (row as ScoreboardPlayerRow | undefined) ?? null;
}

export async function playerHasMatches(playerId: string): Promise<boolean> {
  const rows = await db
    .select({ id: scoreboardMatchPlayers.id })
    .from(scoreboardMatchPlayers)
    .where(eq(scoreboardMatchPlayers.playerId, playerId))
    .limit(1);
  return rows.length > 0;
}

export async function deletePlayer(id: string, userId: string): Promise<boolean> {
  const result = await db
    .delete(scoreboardPlayers)
    .where(and(eq(scoreboardPlayers.id, id), eq(scoreboardPlayers.userId, userId)))
    .returning({ id: scoreboardPlayers.id });
  return result.length > 0;
}

export async function playerIdsExist(ids: string[]): Promise<boolean> {
  const rows = await db
    .select({ id: scoreboardPlayers.id })
    .from(scoreboardPlayers)
    .where(inArray(scoreboardPlayers.id, ids));
  return rows.length === ids.length;
}

// Match + roster insert. Sequential (no transaction): single-writer site,
// and a match orphaned by a mid-insert crash is invisible (no players)
// and deletable. Positions follow the given order.
export async function createMatch(input: {
  userId: string;
  gameId: string;
  playerIds: string[];
  location?: string | null;
}): Promise<ScoreboardMatchRow> {
  const [match] = await db
    .insert(scoreboardMatches)
    .values({
      userId: input.userId,
      gameId: input.gameId,
      location: input.location ?? null,
    })
    .returning();
  const matchRow = match as ScoreboardMatchRow;
  for (let i = 0; i < input.playerIds.length; i++) {
    await db.insert(scoreboardMatchPlayers).values({
      matchId: matchRow.id,
      playerId: input.playerIds[i],
      score: 0,
      position: i,
    });
  }
  return matchRow;
}

export async function getMatch(id: string): Promise<ScoreboardMatchRow | null> {
  const rows = await db
    .select()
    .from(scoreboardMatches)
    .where(eq(scoreboardMatches.id, id))
    .limit(1);
  return (rows[0] as ScoreboardMatchRow | undefined) ?? null;
}

export async function getMatchOwned(
  id: string,
  userId: string,
): Promise<ScoreboardMatchRow | null> {
  const rows = await db
    .select()
    .from(scoreboardMatches)
    .where(and(eq(scoreboardMatches.id, id), eq(scoreboardMatches.userId, userId)))
    .limit(1);
  return (rows[0] as ScoreboardMatchRow | undefined) ?? null;
}

export async function listMatches(opts: {
  gameId?: string;
  status?: string;
  limit: number;
  cursor?: Date;
}): Promise<ScoreboardMatchRow[]> {
  const conditions = [];
  if (opts.gameId) conditions.push(eq(scoreboardMatches.gameId, opts.gameId));
  if (opts.status) conditions.push(eq(scoreboardMatches.status, opts.status));
  if (opts.cursor) conditions.push(lt(scoreboardMatches.createdAt, opts.cursor));
  const rows = await db
    .select()
    .from(scoreboardMatches)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(scoreboardMatches.createdAt))
    .limit(opts.limit);
  return rows as ScoreboardMatchRow[];
}

export async function listMatchPlayers(
  matchIds: string[],
): Promise<MatchPlayerJoinedRow[]> {
  if (matchIds.length === 0) return [];
  const rows = await db
    .select({
      matchId: scoreboardMatchPlayers.matchId,
      playerId: scoreboardMatchPlayers.playerId,
      name: scoreboardPlayers.name,
      color: scoreboardPlayers.color,
      score: scoreboardMatchPlayers.score,
      position: scoreboardMatchPlayers.position,
    })
    .from(scoreboardMatchPlayers)
    .innerJoin(
      scoreboardPlayers,
      eq(scoreboardMatchPlayers.playerId, scoreboardPlayers.id),
    )
    .where(inArray(scoreboardMatchPlayers.matchId, matchIds))
    .orderBy(asc(scoreboardMatchPlayers.position));
  return rows as MatchPlayerJoinedRow[];
}

// Atomic increment clamped at zero so an over-eager -1 can't go negative
// and two quick taps can't clobber each other with stale reads.
export async function incrementScore(
  matchId: string,
  playerId: string,
  delta: number,
): Promise<{ score: number } | null> {
  const [row] = await db
    .update(scoreboardMatchPlayers)
    .set({ score: sql`greatest(${scoreboardMatchPlayers.score} + ${delta}, 0)` })
    .where(
      and(
        eq(scoreboardMatchPlayers.matchId, matchId),
        eq(scoreboardMatchPlayers.playerId, playerId),
      ),
    )
    .returning({ score: scoreboardMatchPlayers.score });
  return (row as { score: number } | undefined) ?? null;
}

export async function finishMatch(
  id: string,
  userId: string,
  winnerPlayerId: string,
): Promise<ScoreboardMatchRow | null> {
  const [row] = await db
    .update(scoreboardMatches)
    .set({ status: "final", winnerPlayerId, updatedAt: new Date() })
    .where(
      and(
        eq(scoreboardMatches.id, id),
        eq(scoreboardMatches.userId, userId),
        eq(scoreboardMatches.status, "live"),
      ),
    )
    .returning();
  return (row as ScoreboardMatchRow | undefined) ?? null;
}

export async function reopenMatch(
  id: string,
  userId: string,
): Promise<ScoreboardMatchRow | null> {
  const [row] = await db
    .update(scoreboardMatches)
    .set({ status: "live", winnerPlayerId: null, updatedAt: new Date() })
    .where(
      and(
        eq(scoreboardMatches.id, id),
        eq(scoreboardMatches.userId, userId),
        eq(scoreboardMatches.status, "final"),
      ),
    )
    .returning();
  return (row as ScoreboardMatchRow | undefined) ?? null;
}

export async function deleteMatch(id: string, userId: string): Promise<boolean> {
  const result = await db
    .delete(scoreboardMatches)
    .where(and(eq(scoreboardMatches.id, id), eq(scoreboardMatches.userId, userId)))
    .returning({ id: scoreboardMatches.id });
  return result.length > 0;
}
