import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

const m = vi.hoisted(() => ({
  listGames: vi.fn(),
  gameWinStats: vi.fn(),
  createGame: vi.fn(),
  updateGame: vi.fn(),
  deleteGame: vi.fn(),
  listPlayers: vi.fn(),
  createPlayer: vi.fn(),
  updatePlayer: vi.fn(),
  deletePlayer: vi.fn(),
  playerHasMatches: vi.fn(),
  playerIdsExist: vi.fn(),
  createMatch: vi.fn(),
  getMatch: vi.fn(),
  getMatchOwned: vi.fn(),
  listMatches: vi.fn(),
  listMatchPlayers: vi.fn(),
  updateMatch: vi.fn(),
  incrementScore: vi.fn(),
  finishMatch: vi.fn(),
  reopenMatch: vi.fn(),
  deleteMatch: vi.fn(),
  searchIcons: vi.fn(),
  fetchIconPath: vi.fn(),
}));

vi.mock("@/modules/scoreboard/repo", async () => {
  return {
    SCOREBOARD_COLORS: [
      "amber", "sky", "emerald", "fuchsia", "rose",
      "violet", "lime", "cyan", "orange", "teal",
    ],
    listGames: m.listGames,
    gameWinStats: m.gameWinStats,
    createGame: m.createGame,
    updateGame: m.updateGame,
    deleteGame: m.deleteGame,
    listPlayers: m.listPlayers,
    createPlayer: m.createPlayer,
    updatePlayer: m.updatePlayer,
    deletePlayer: m.deletePlayer,
    playerHasMatches: m.playerHasMatches,
    playerIdsExist: m.playerIdsExist,
    createMatch: m.createMatch,
    getMatch: m.getMatch,
    getMatchOwned: m.getMatchOwned,
    listMatches: m.listMatches,
    listMatchPlayers: m.listMatchPlayers,
    updateMatch: m.updateMatch,
    incrementScore: m.incrementScore,
    finishMatch: m.finishMatch,
    reopenMatch: m.reopenMatch,
    deleteMatch: m.deleteMatch,
  };
});
vi.mock("@/modules/scoreboard/icon-search", () => ({
  searchIcons: m.searchIcons,
  fetchIconPath: m.fetchIconPath,
}));
vi.mock("@/modules/shared/rate-limit", () => ({
  createPATRateLimit: () => async (_c: any, next: any) => {
    await next();
  },
}));
vi.mock("@/modules/auth/middleware", () => ({
  requireAuth: async (c: any, next: any) => {
    const u = c.req.header("X-Test-User");
    if (!u) return c.json({ error: "auth" }, 401);
    c.set("userId", u);
    c.set("tokenScopes", null);
    await next();
  },
  requireScope: () => async (_c: any, next: any) => {
    await next();
  },
}));

import { scoreboardRoutes } from "@/modules/scoreboard/routes";

beforeEach(() => vi.clearAllMocks());
const app = new Hono().route("/api/scoreboard", scoreboardRoutes);

const GAME_ID = "11111111-1111-1111-1111-111111111111";
const MATCH_ID = "22222222-2222-2222-2222-222222222222";
const P1 = "33333333-3333-3333-3333-333333333333";
const P2 = "44444444-4444-4444-4444-444444444444";

const GAME_ROW = {
  id: GAME_ID, userId: "u1", name: "Pool", description: null, rules: null,
  iconPath: "M1 1", iconViewBox: "0 0 512 512", iconSlug: "delapouite/8-ball",
  color: "amber", createdAt: new Date(), updatedAt: new Date(),
};
const MATCH_ROW = {
  id: MATCH_ID, userId: "u1", gameId: GAME_ID, location: "Frisco",
  status: "live", winnerPlayerId: null,
  playedAt: new Date(), createdAt: new Date(), updatedAt: new Date(),
};
const MP_ROWS = [
  { matchId: MATCH_ID, playerId: P1, name: "Shane", color: "sky", score: 1, position: 0 },
  { matchId: MATCH_ID, playerId: P2, name: "Kalina", color: "rose", score: 2, position: 1 },
];

function req(path: string, method: string, body?: unknown, user?: string) {
  return app.request(`/api/scoreboard${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(user ? { "X-Test-User": user } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

describe("public reads", () => {
  it("GET /games returns games + stats without auth", async () => {
    m.listGames.mockResolvedValue([GAME_ROW]);
    m.gameWinStats.mockResolvedValue([{ gameId: GAME_ID, playerId: P2, wins: 1 }]);
    const res = await req("/games", "GET");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.games[0]).toMatchObject({
      id: GAME_ID,
      name: "Pool",
      icon: { path: "M1 1", viewBox: "0 0 512 512", slug: "delapouite/8-ball" },
    });
    expect(data.stats).toHaveLength(1);
  });

  it("GET /players returns players without auth", async () => {
    m.listPlayers.mockResolvedValue([
      { id: P1, userId: "u1", name: "Shane", color: "sky", createdAt: new Date() },
    ]);
    const res = await req("/players", "GET");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.players[0]).toMatchObject({ id: P1, name: "Shane" });
    expect(data.players[0]).not.toHaveProperty("userId");
  });

  it("GET /matches groups players per match", async () => {
    m.listMatches.mockResolvedValue([MATCH_ROW]);
    m.listMatchPlayers.mockResolvedValue(MP_ROWS);
    const res = await req("/matches", "GET");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.matches[0].players).toHaveLength(2);
    expect(data.matches[0].players[1]).toMatchObject({ name: "Kalina", score: 2 });
  });

  it("GET /matches/:id 404s on unknown match", async () => {
    m.getMatch.mockResolvedValue(null);
    const res = await req(`/matches/${MATCH_ID}`, "GET");
    expect(res.status).toBe(404);
  });
});

describe("icon search", () => {
  it("401 without auth", async () => {
    const res = await req("/icons/search?q=pool", "GET");
    expect(res.status).toBe(401);
  });

  it("200 with results when authed", async () => {
    m.searchIcons.mockResolvedValue([
      { slug: "delapouite/8-ball", previewUrl: "https://x/8-ball.svg" },
    ]);
    const res = await req("/icons/search?q=pool", "GET", undefined, "u1");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.results[0].slug).toBe("delapouite/8-ball");
  });

  it("degrades to empty results when the search throws", async () => {
    m.searchIcons.mockRejectedValue(new Error("github down"));
    const res = await req("/icons/search?q=pool", "GET", undefined, "u1");
    expect(res.status).toBe(200);
    expect((await res.json()).results).toEqual([]);
  });
});

describe("game writes", () => {
  it("401 without auth", async () => {
    const res = await req("/games", "POST", { name: "Pool", iconSlug: "a/b" });
    expect(res.status).toBe(401);
  });

  it("fetches the icon and creates the game (201)", async () => {
    m.fetchIconPath.mockResolvedValue({
      path: "M1 1", viewBox: "0 0 512 512", slug: "delapouite/8-ball",
    });
    m.createGame.mockResolvedValue(GAME_ROW);
    const res = await req(
      "/games", "POST",
      { name: "  Pool  ", iconSlug: "delapouite/8-ball" },
      "u1",
    );
    expect(res.status).toBe(201);
    expect(m.fetchIconPath).toHaveBeenCalledWith("delapouite/8-ball");
    expect(m.createGame).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "u1", name: "Pool",
        iconPath: "M1 1", iconViewBox: "0 0 512 512", iconSlug: "delapouite/8-ball",
      }),
    );
  });

  it("502 with a clear error when the icon fetch fails", async () => {
    m.fetchIconPath.mockRejectedValue(new Error("boom"));
    const res = await req(
      "/games", "POST",
      { name: "Pool", iconSlug: "delapouite/8-ball" },
      "u1",
    );
    expect(res.status).toBe(502);
    expect((await res.json()).error).toMatch(/icon/i);
    expect(m.createGame).not.toHaveBeenCalled();
  });

  it("400 on whitespace-only name without touching the repo", async () => {
    const res = await req(
      "/games", "POST",
      { name: "   ", iconSlug: "delapouite/8-ball" },
      "u1",
    );
    expect(res.status).toBe(400);
    expect(m.createGame).not.toHaveBeenCalled();
  });

  it("400 on a bad icon slug", async () => {
    const res = await req(
      "/games", "POST",
      { name: "Pool", iconSlug: "../etc/passwd" },
      "u1",
    );
    expect(res.status).toBe(400);
  });
});

describe("player writes", () => {
  it("creates a player (201)", async () => {
    m.createPlayer.mockResolvedValue({
      id: P1, userId: "u1", name: "Kalina", color: "rose", createdAt: new Date(),
    });
    const res = await req("/players", "POST", { name: "  Kalina  " }, "u1");
    expect(res.status).toBe(201);
    expect(m.createPlayer).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Kalina" }),
    );
  });

  it("DELETE 409s when the player has matches", async () => {
    m.playerHasMatches.mockResolvedValue(true);
    const res = await req(`/players/${P1}`, "DELETE", undefined, "u1");
    expect(res.status).toBe(409);
    expect(m.deletePlayer).not.toHaveBeenCalled();
  });

  it("DELETE 204s otherwise", async () => {
    m.playerHasMatches.mockResolvedValue(false);
    m.deletePlayer.mockResolvedValue(true);
    const res = await req(`/players/${P1}`, "DELETE", undefined, "u1");
    expect(res.status).toBe(204);
  });
});

describe("match writes", () => {
  it("POST /matches 400 on duplicate playerIds", async () => {
    const res = await req(
      "/matches", "POST",
      { gameId: GAME_ID, playerIds: [P1, P1] },
      "u1",
    );
    expect(res.status).toBe(400);
    expect(m.createMatch).not.toHaveBeenCalled();
  });

  it("POST /matches 400 when a player id is unknown", async () => {
    m.playerIdsExist.mockResolvedValue(false);
    const res = await req(
      "/matches", "POST",
      { gameId: GAME_ID, playerIds: [P1, P2] },
      "u1",
    );
    expect(res.status).toBe(400);
  });

  it("POST /matches 201 happy path", async () => {
    m.playerIdsExist.mockResolvedValue(true);
    m.createMatch.mockResolvedValue(MATCH_ROW);
    m.listMatchPlayers.mockResolvedValue(MP_ROWS);
    const res = await req(
      "/matches", "POST",
      { gameId: GAME_ID, playerIds: [P1, P2], location: "Frisco" },
      "u1",
    );
    expect(res.status).toBe(201);
    expect((await res.json()).match.players).toHaveLength(2);
  });

  it("PATCH /matches/:id 401s without auth", async () => {
    const res = await req(`/matches/${MATCH_ID}`, "PATCH", { location: "Legacy West" });
    expect(res.status).toBe(401);
    expect(m.updateMatch).not.toHaveBeenCalled();
  });

  it("PATCH /matches/:id updates the location and returns the match", async () => {
    m.updateMatch.mockResolvedValue({ ...MATCH_ROW, location: "Legacy West" });
    m.listMatchPlayers.mockResolvedValue(MP_ROWS);
    const res = await req(
      `/matches/${MATCH_ID}`, "PATCH",
      { location: "  Legacy West  " },
      "u1",
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.match.location).toBe("Legacy West");
    expect(data.match.players).toHaveLength(2);
    // whitespace is trimmed before it reaches the repo
    expect(m.updateMatch).toHaveBeenCalledWith(MATCH_ID, "u1", {
      location: "Legacy West",
    });
  });

  it("PATCH /matches/:id clears the location on an explicit null", async () => {
    m.updateMatch.mockResolvedValue({ ...MATCH_ROW, location: null });
    m.listMatchPlayers.mockResolvedValue(MP_ROWS);
    const res = await req(`/matches/${MATCH_ID}`, "PATCH", { location: null }, "u1");
    expect(res.status).toBe(200);
    expect(m.updateMatch).toHaveBeenCalledWith(MATCH_ID, "u1", { location: null });
  });

  it("PATCH /matches/:id collapses a whitespace-only location to null", async () => {
    m.updateMatch.mockResolvedValue({ ...MATCH_ROW, location: null });
    m.listMatchPlayers.mockResolvedValue(MP_ROWS);
    const res = await req(`/matches/${MATCH_ID}`, "PATCH", { location: "   " }, "u1");
    expect(res.status).toBe(200);
    expect(m.updateMatch).toHaveBeenCalledWith(MATCH_ID, "u1", { location: null });
  });

  it("PATCH /matches/:id 400s on an empty patch", async () => {
    const res = await req(`/matches/${MATCH_ID}`, "PATCH", {}, "u1");
    expect(res.status).toBe(400);
    expect(m.updateMatch).not.toHaveBeenCalled();
  });

  it("PATCH /matches/:id 400s on an over-long location", async () => {
    const res = await req(
      `/matches/${MATCH_ID}`, "PATCH",
      { location: "x".repeat(161) },
      "u1",
    );
    expect(res.status).toBe(400);
    expect(m.updateMatch).not.toHaveBeenCalled();
  });

  it("PATCH /matches/:id 404s when the match is not owned", async () => {
    m.updateMatch.mockResolvedValue(null);
    const res = await req(`/matches/${MATCH_ID}`, "PATCH", { location: "x" }, "u2");
    expect(res.status).toBe(404);
  });

  it("score: 404 on unknown match", async () => {
    m.getMatchOwned.mockResolvedValue(null);
    const res = await req(
      `/matches/${MATCH_ID}/score`, "PATCH",
      { playerId: P1, delta: 1 },
      "u1",
    );
    expect(res.status).toBe(404);
  });

  it("score: 409 when the match is final", async () => {
    m.getMatchOwned.mockResolvedValue({ ...MATCH_ROW, status: "final" });
    const res = await req(
      `/matches/${MATCH_ID}/score`, "PATCH",
      { playerId: P1, delta: 1 },
      "u1",
    );
    expect(res.status).toBe(409);
    expect(m.incrementScore).not.toHaveBeenCalled();
  });

  it("score: 200 increments and returns the match", async () => {
    m.getMatchOwned.mockResolvedValue(MATCH_ROW);
    m.incrementScore.mockResolvedValue({ score: 2 });
    m.listMatchPlayers.mockResolvedValue(MP_ROWS);
    const res = await req(
      `/matches/${MATCH_ID}/score`, "PATCH",
      { playerId: P2, delta: 1 },
      "u1",
    );
    expect(res.status).toBe(200);
    expect(m.incrementScore).toHaveBeenCalledWith(MATCH_ID, P2, 1);
  });

  it("score: 400 rejects a delta other than 1 or -1", async () => {
    const res = await req(
      `/matches/${MATCH_ID}/score`, "PATCH",
      { playerId: P1, delta: 5 },
      "u1",
    );
    expect(res.status).toBe(400);
  });

  it("finish: 400 when the winner is not a participant", async () => {
    m.listMatchPlayers.mockResolvedValue(MP_ROWS);
    const res = await req(
      `/matches/${MATCH_ID}/finish`, "POST",
      { winnerPlayerId: GAME_ID },
      "u1",
    );
    expect(res.status).toBe(400);
    expect(m.finishMatch).not.toHaveBeenCalled();
  });

  it("finish: 409 when already final", async () => {
    m.listMatchPlayers.mockResolvedValue(MP_ROWS);
    m.finishMatch.mockResolvedValue(null);
    m.getMatchOwned.mockResolvedValue({ ...MATCH_ROW, status: "final" });
    const res = await req(
      `/matches/${MATCH_ID}/finish`, "POST",
      { winnerPlayerId: P2 },
      "u1",
    );
    expect(res.status).toBe(409);
  });

  it("finish: 200 happy path", async () => {
    m.listMatchPlayers.mockResolvedValue(MP_ROWS);
    m.finishMatch.mockResolvedValue({
      ...MATCH_ROW, status: "final", winnerPlayerId: P2,
    });
    const res = await req(
      `/matches/${MATCH_ID}/finish`, "POST",
      { winnerPlayerId: P2 },
      "u1",
    );
    expect(res.status).toBe(200);
    expect((await res.json()).match.winnerPlayerId).toBe(P2);
  });

  it("reopen: 409 when the match is live", async () => {
    m.reopenMatch.mockResolvedValue(null);
    m.getMatchOwned.mockResolvedValue(MATCH_ROW);
    const res = await req(`/matches/${MATCH_ID}/reopen`, "POST", undefined, "u1");
    expect(res.status).toBe(409);
  });

  it("reopen: 200 from final", async () => {
    m.reopenMatch.mockResolvedValue(MATCH_ROW);
    m.listMatchPlayers.mockResolvedValue(MP_ROWS);
    const res = await req(`/matches/${MATCH_ID}/reopen`, "POST", undefined, "u1");
    expect(res.status).toBe(200);
  });

  it("DELETE /matches/:id 204", async () => {
    m.deleteMatch.mockResolvedValue(true);
    const res = await req(`/matches/${MATCH_ID}`, "DELETE", undefined, "u1");
    expect(res.status).toBe(204);
  });
});
