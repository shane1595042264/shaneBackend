import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { requireAuth, requireScope } from "@/modules/auth/middleware";
import { createPATRateLimit } from "@/modules/shared/rate-limit";
import {
  trimmedRequired,
  trimmedOptional,
  trimmedNullish,
} from "@/modules/shared/validators";
import { searchIcons, fetchIconPath } from "./icon-search";
import {
  SCOREBOARD_COLORS,
  createGame,
  updateGame,
  deleteGame,
  listGames,
  gameWinStats,
  createPlayer,
  updatePlayer,
  deletePlayer,
  listPlayers,
  playerHasMatches,
  playerIdsExist,
  createMatch,
  getMatch,
  getMatchOwned,
  listMatches,
  listMatchPlayers,
  incrementScore,
  finishMatch,
  reopenMatch,
  deleteMatch,
  type ScoreboardGameRow,
  type ScoreboardPlayerRow,
  type ScoreboardMatchRow,
  type MatchPlayerJoinedRow,
} from "./repo";

// Per-PAT 60s rolling write limit. JWT browser sessions bypass. Distinct
// bucket so a busy scoreboard session doesn't lock out journal writes.
const scoreboardWriteLimit = createPATRateLimit({
  bucket: "scoreboard-write",
  limitPerMinute: 60,
});

type Vars = { Variables: { userId: string | null; tokenScopes: string[] | null } };
export const scoreboardRoutes = new Hono<Vars>();

const idParam = z.object({ id: z.string().uuid() });
const colorSchema = z.enum(SCOREBOARD_COLORS);
const iconSlugSchema = z
  .string()
  .regex(/^[a-z0-9-]+\/[a-z0-9-]+$/, "Invalid icon slug");

const createGameBody = z.object({
  name: trimmedRequired(120),
  description: trimmedNullish(4000),
  rules: trimmedNullish(4000),
  iconSlug: iconSlugSchema,
  color: colorSchema.optional(),
});

const patchGameBody = z
  .object({
    name: trimmedOptional(120),
    description: trimmedNullish(4000),
    rules: trimmedNullish(4000),
    iconSlug: iconSlugSchema.optional(),
    color: colorSchema.optional(),
  })
  .refine(
    (b) =>
      b.name !== undefined ||
      b.description !== undefined ||
      b.rules !== undefined ||
      b.iconSlug !== undefined ||
      b.color !== undefined,
    { message: "At least one field is required" },
  );

const createPlayerBody = z.object({
  name: trimmedRequired(80),
  color: colorSchema.optional(),
});

const patchPlayerBody = z
  .object({ name: trimmedOptional(80), color: colorSchema.optional() })
  .refine((b) => b.name !== undefined || b.color !== undefined, {
    message: "At least one field is required",
  });

const createMatchBody = z.object({
  gameId: z.string().uuid(),
  playerIds: z.array(z.string().uuid()).min(2).max(8),
  location: trimmedNullish(160),
});

const scoreBody = z.object({
  playerId: z.string().uuid(),
  delta: z.union([z.literal(1), z.literal(-1)]),
});

const finishBody = z.object({ winnerPlayerId: z.string().uuid() });

const matchesQuery = z.object({
  gameId: z.string().uuid().optional(),
  status: z.enum(["live", "final"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().datetime().optional(),
});

const iconsQuery = z.object({ q: z.string().trim().min(2).max(60) });

function serializeGame(row: ScoreboardGameRow) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    rules: row.rules,
    icon: { path: row.iconPath, viewBox: row.iconViewBox, slug: row.iconSlug },
    color: row.color,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function serializePlayer(row: ScoreboardPlayerRow) {
  return { id: row.id, name: row.name, color: row.color, createdAt: row.createdAt };
}

function serializeMatch(row: ScoreboardMatchRow, players: MatchPlayerJoinedRow[]) {
  return {
    id: row.id,
    gameId: row.gameId,
    location: row.location,
    status: row.status,
    winnerPlayerId: row.winnerPlayerId,
    playedAt: row.playedAt,
    createdAt: row.createdAt,
    players: players
      .filter((p) => p.matchId === row.id)
      .map((p) => ({
        playerId: p.playerId,
        name: p.name,
        color: p.color,
        score: p.score,
        position: p.position,
      })),
  };
}

async function serializeMatchById(row: ScoreboardMatchRow) {
  const players = await listMatchPlayers([row.id]);
  return serializeMatch(row, players);
}

// ---- Public reads --------------------------------------------------------

scoreboardRoutes.get("/games", async (c) => {
  const [games, stats] = await Promise.all([listGames(), gameWinStats()]);
  return c.json({ games: games.map(serializeGame), stats });
});

scoreboardRoutes.get("/players", async (c) => {
  const players = await listPlayers();
  return c.json({ players: players.map(serializePlayer) });
});

scoreboardRoutes.get("/matches", zValidator("query", matchesQuery), async (c) => {
  const { gameId, status, limit, cursor } = c.req.valid("query");
  const matches = await listMatches({
    gameId,
    status,
    limit,
    cursor: cursor ? new Date(cursor) : undefined,
  });
  const players = await listMatchPlayers(matches.map((m) => m.id));
  return c.json({ matches: matches.map((m) => serializeMatch(m, players)) });
});

scoreboardRoutes.get("/matches/:id", zValidator("param", idParam), async (c) => {
  const { id } = c.req.valid("param");
  const match = await getMatch(id);
  if (!match) return c.json({ error: "Not found" }, 404);
  return c.json({ match: await serializeMatchById(match) });
});

// ---- Icon search (authed read: it spends GitHub API quota) ---------------

scoreboardRoutes.get(
  "/icons/search",
  requireAuth,
  zValidator("query", iconsQuery),
  async (c) => {
    const { q } = c.req.valid("query");
    try {
      const results = await searchIcons(q);
      return c.json({ results });
    } catch {
      // Cold cache AND GitHub down: degrade to an empty list; the add-game
      // form offers its fallback icon instead of blocking the flow.
      return c.json({ results: [] });
    }
  },
);

// ---- Game writes ---------------------------------------------------------

scoreboardRoutes.post(
  "/games",
  requireAuth,
  requireScope("entries:write"),
  scoreboardWriteLimit,
  zValidator("json", createGameBody),
  async (c) => {
    const userId = c.get("userId") as string;
    const { name, description, rules, iconSlug, color } = c.req.valid("json");
    let icon;
    try {
      icon = await fetchIconPath(iconSlug);
    } catch {
      return c.json({ error: "Could not fetch icon art. Try a different icon." }, 502);
    }
    const row = await createGame({
      userId,
      name,
      description,
      rules,
      iconPath: icon.path,
      iconViewBox: icon.viewBox,
      iconSlug: icon.slug,
      color,
    });
    return c.json({ game: serializeGame(row) }, 201);
  },
);

scoreboardRoutes.patch(
  "/games/:id",
  requireAuth,
  requireScope("entries:write"),
  scoreboardWriteLimit,
  zValidator("param", idParam),
  zValidator("json", patchGameBody),
  async (c) => {
    const userId = c.get("userId") as string;
    const { id } = c.req.valid("param");
    const { iconSlug, ...rest } = c.req.valid("json");
    let icon;
    if (iconSlug !== undefined) {
      try {
        icon = await fetchIconPath(iconSlug);
      } catch {
        return c.json({ error: "Could not fetch icon art. Try a different icon." }, 502);
      }
    }
    const row = await updateGame(id, userId, { ...rest, icon });
    if (!row) return c.json({ error: "Not found or not owner" }, 404);
    return c.json({ game: serializeGame(row) });
  },
);

scoreboardRoutes.delete(
  "/games/:id",
  requireAuth,
  requireScope("entries:write"),
  scoreboardWriteLimit,
  zValidator("param", idParam),
  async (c) => {
    const userId = c.get("userId") as string;
    const { id } = c.req.valid("param");
    const ok = await deleteGame(id, userId);
    return ok ? c.body(null, 204) : c.json({ error: "Not found or not owner" }, 404);
  },
);

// ---- Player writes -------------------------------------------------------

scoreboardRoutes.post(
  "/players",
  requireAuth,
  requireScope("entries:write"),
  scoreboardWriteLimit,
  zValidator("json", createPlayerBody),
  async (c) => {
    const userId = c.get("userId") as string;
    const { name, color } = c.req.valid("json");
    const row = await createPlayer({ userId, name, color });
    return c.json({ player: serializePlayer(row) }, 201);
  },
);

scoreboardRoutes.patch(
  "/players/:id",
  requireAuth,
  requireScope("entries:write"),
  scoreboardWriteLimit,
  zValidator("param", idParam),
  zValidator("json", patchPlayerBody),
  async (c) => {
    const userId = c.get("userId") as string;
    const { id } = c.req.valid("param");
    const row = await updatePlayer(id, userId, c.req.valid("json"));
    if (!row) return c.json({ error: "Not found or not owner" }, 404);
    return c.json({ player: serializePlayer(row) });
  },
);

scoreboardRoutes.delete(
  "/players/:id",
  requireAuth,
  requireScope("entries:write"),
  scoreboardWriteLimit,
  zValidator("param", idParam),
  async (c) => {
    const userId = c.get("userId") as string;
    const { id } = c.req.valid("param");
    if (await playerHasMatches(id)) {
      return c.json({ error: "Player has recorded matches. Delete those first." }, 409);
    }
    const ok = await deletePlayer(id, userId);
    return ok ? c.body(null, 204) : c.json({ error: "Not found or not owner" }, 404);
  },
);

// ---- Match writes --------------------------------------------------------

scoreboardRoutes.post(
  "/matches",
  requireAuth,
  requireScope("entries:write"),
  scoreboardWriteLimit,
  zValidator("json", createMatchBody),
  async (c) => {
    const userId = c.get("userId") as string;
    const { gameId, playerIds, location } = c.req.valid("json");
    if (new Set(playerIds).size !== playerIds.length) {
      return c.json({ error: "playerIds contains duplicates" }, 400);
    }
    if (!(await playerIdsExist(playerIds))) {
      return c.json({ error: "Unknown player id" }, 400);
    }
    const row = await createMatch({ userId, gameId, playerIds, location });
    return c.json({ match: await serializeMatchById(row) }, 201);
  },
);

scoreboardRoutes.patch(
  "/matches/:id/score",
  requireAuth,
  requireScope("entries:write"),
  scoreboardWriteLimit,
  zValidator("param", idParam),
  zValidator("json", scoreBody),
  async (c) => {
    const userId = c.get("userId") as string;
    const { id } = c.req.valid("param");
    const { playerId, delta } = c.req.valid("json");
    const match = await getMatchOwned(id, userId);
    if (!match) return c.json({ error: "Not found or not owner" }, 404);
    if (match.status !== "live") {
      return c.json({ error: "Match is final. Reopen it to change scores." }, 409);
    }
    const updated = await incrementScore(id, playerId, delta);
    if (!updated) return c.json({ error: "Player is not in this match" }, 404);
    return c.json({ match: await serializeMatchById(match) });
  },
);

scoreboardRoutes.post(
  "/matches/:id/finish",
  requireAuth,
  requireScope("entries:write"),
  scoreboardWriteLimit,
  zValidator("param", idParam),
  zValidator("json", finishBody),
  async (c) => {
    const userId = c.get("userId") as string;
    const { id } = c.req.valid("param");
    const { winnerPlayerId } = c.req.valid("json");
    const participants = await listMatchPlayers([id]);
    if (!participants.some((p) => p.playerId === winnerPlayerId)) {
      return c.json({ error: "Winner must be a player in this match" }, 400);
    }
    const row = await finishMatch(id, userId, winnerPlayerId);
    if (!row) {
      const existing = await getMatchOwned(id, userId);
      if (!existing) return c.json({ error: "Not found or not owner" }, 404);
      return c.json({ error: "Match is already final" }, 409);
    }
    return c.json({ match: await serializeMatchById(row) });
  },
);

scoreboardRoutes.post(
  "/matches/:id/reopen",
  requireAuth,
  requireScope("entries:write"),
  scoreboardWriteLimit,
  zValidator("param", idParam),
  async (c) => {
    const userId = c.get("userId") as string;
    const { id } = c.req.valid("param");
    const row = await reopenMatch(id, userId);
    if (!row) {
      const existing = await getMatchOwned(id, userId);
      if (!existing) return c.json({ error: "Not found or not owner" }, 404);
      return c.json({ error: "Match is not final" }, 409);
    }
    return c.json({ match: await serializeMatchById(row) });
  },
);

scoreboardRoutes.delete(
  "/matches/:id",
  requireAuth,
  requireScope("entries:write"),
  scoreboardWriteLimit,
  zValidator("param", idParam),
  async (c) => {
    const userId = c.get("userId") as string;
    const { id } = c.req.valid("param");
    const ok = await deleteMatch(id, userId);
    return ok ? c.body(null, 204) : c.json({ error: "Not found or not owner" }, 404);
  },
);
