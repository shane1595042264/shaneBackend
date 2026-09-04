import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockSelect, mockInsert, mockDelete, mockUpdate } = vi.hoisted(() => ({
  mockSelect: vi.fn(),
  mockInsert: vi.fn(),
  mockDelete: vi.fn(),
  mockUpdate: vi.fn(),
}));

vi.mock("@/db/client", () => ({
  db: { select: mockSelect, insert: mockInsert, delete: mockDelete, update: mockUpdate },
}));
vi.mock("@/db/schema", () => ({
  scoreboardGames: {
    id: {}, userId: {}, name: {}, description: {}, rules: {},
    iconPath: {}, iconViewBox: {}, iconSlug: {}, color: {},
    createdAt: {}, updatedAt: {},
  },
  scoreboardPlayers: {
    id: {}, userId: {}, name: {}, color: {}, createdAt: {},
  },
  scoreboardMatches: {
    id: {}, userId: {}, gameId: {}, location: {}, status: {},
    winnerPlayerId: {}, playedAt: {}, createdAt: {}, updatedAt: {},
  },
  scoreboardMatchPlayers: {
    id: {}, matchId: {}, playerId: {}, score: {}, position: {},
  },
}));
vi.mock("drizzle-orm", () => ({
  eq: vi.fn((c: unknown, v: unknown) => ({ eq: [c, v] })),
  and: vi.fn((...args: unknown[]) => ({ and: args })),
  asc: vi.fn((c: unknown) => ({ c, dir: "asc" })),
  desc: vi.fn((c: unknown) => ({ c, dir: "desc" })),
  lt: vi.fn((c: unknown, v: unknown) => ({ lt: [c, v] })),
  inArray: vi.fn((c: unknown, v: unknown) => ({ inArray: [c, v] })),
  sql: Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => ({ kind: "sql", strings, values }),
    { raw: (s: string) => ({ kind: "sql-raw", s }) },
  ),
}));

function chain(rows: unknown[]) {
  const c: Record<string, unknown> = {};
  const t = Promise.resolve(rows);
  for (const m of ["from", "where", "orderBy", "limit", "innerJoin", "groupBy"]) {
    c[m] = vi.fn(() => c);
  }
  Object.assign(c, { then: (r: any, j: any) => t.then(r, j) });
  return c;
}

function insertChain(rows: unknown[]) {
  return {
    values: vi.fn(() => ({
      returning: vi.fn(() => Promise.resolve(rows)),
    })),
  };
}

function updateChain(rows: unknown[]) {
  const where = vi.fn(() => ({ returning: vi.fn(() => Promise.resolve(rows)) }));
  const set = vi.fn(() => ({ where }));
  return { set, where };
}

import {
  SCOREBOARD_COLORS,
  createGame,
  updateGame,
  createMatch,
  updateMatch,
  incrementScore,
  decideWinner,
  finishMatch,
  reopenMatch,
  playerHasMatches,
  listMatches,
} from "@/modules/scoreboard/repo";
import { and, eq } from "drizzle-orm";

beforeEach(() => vi.clearAllMocks());

const GAME_ROW = {
  id: "g1", userId: "u1", name: "Pool", description: null, rules: null,
  iconPath: "M1 1", iconViewBox: "0 0 512 512", iconSlug: "delapouite/8-ball",
  color: "amber", createdAt: new Date(), updatedAt: new Date(),
};

describe("createGame", () => {
  it("auto-assigns a palette color from the game count when none given", async () => {
    mockSelect.mockReturnValue(chain([{ n: 3 }]));
    const ins = insertChain([{ ...GAME_ROW, color: SCOREBOARD_COLORS[3] }]);
    mockInsert.mockReturnValue(ins);
    await createGame({
      userId: "u1", name: "Pool",
      iconPath: "M1 1", iconViewBox: "0 0 512 512", iconSlug: "delapouite/8-ball",
    });
    const values = ins.values.mock.calls[0][0] as Record<string, unknown>;
    expect(values.color).toBe(SCOREBOARD_COLORS[3]);
    expect(values.description).toBeNull();
  });

  it("uses the explicit color and stores icon fields", async () => {
    const ins = insertChain([GAME_ROW]);
    mockInsert.mockReturnValue(ins);
    await createGame({
      userId: "u1", name: "Pool", color: "rose",
      iconPath: "M1 1", iconViewBox: "0 0 512 512", iconSlug: "delapouite/8-ball",
    });
    expect(mockSelect).not.toHaveBeenCalled();
    const values = ins.values.mock.calls[0][0] as Record<string, unknown>;
    expect(values).toMatchObject({
      color: "rose",
      iconPath: "M1 1",
      iconViewBox: "0 0 512 512",
      iconSlug: "delapouite/8-ball",
    });
  });
});

describe("updateGame", () => {
  it("only sets provided fields plus updatedAt", async () => {
    const ch = updateChain([GAME_ROW]);
    mockUpdate.mockReturnValue(ch);
    await updateGame("g1", "u1", { name: "Billiards" });
    const setArg = ch.set.mock.calls[0][0] as Record<string, unknown>;
    expect(setArg).toHaveProperty("name", "Billiards");
    expect(setArg).toHaveProperty("updatedAt");
    expect(setArg).not.toHaveProperty("rules");
    expect(setArg).not.toHaveProperty("iconPath");
  });

  it("expands an icon patch into the three icon columns", async () => {
    const ch = updateChain([GAME_ROW]);
    mockUpdate.mockReturnValue(ch);
    await updateGame("g1", "u1", {
      icon: { path: "M2 2", viewBox: "0 0 512 512", slug: "lorc/dart" },
    });
    const setArg = ch.set.mock.calls[0][0] as Record<string, unknown>;
    expect(setArg).toMatchObject({
      iconPath: "M2 2",
      iconViewBox: "0 0 512 512",
      iconSlug: "lorc/dart",
    });
  });

  it("returns null when no row matched (missing or not owner)", async () => {
    const ch = updateChain([]);
    mockUpdate.mockReturnValue(ch);
    expect(await updateGame("g1", "u-other", { name: "x" })).toBeNull();
  });
});

describe("createMatch", () => {
  it("inserts the match then one match_player per id with position = index", async () => {
    const matchRow = {
      id: "m1", userId: "u1", gameId: "g1", location: "Frisco",
      status: "live", winnerPlayerId: null,
      playedAt: new Date(), createdAt: new Date(), updatedAt: new Date(),
    };
    const matchIns = insertChain([matchRow]);
    const mpIns1 = insertChain([{ id: "mp1" }]);
    const mpIns2 = insertChain([{ id: "mp2" }]);
    // match_players inserts resolve via values() without returning()
    (mpIns1.values as ReturnType<typeof vi.fn>).mockReturnValue(Promise.resolve([]));
    (mpIns2.values as ReturnType<typeof vi.fn>).mockReturnValue(Promise.resolve([]));
    mockInsert
      .mockReturnValueOnce(matchIns)
      .mockReturnValueOnce(mpIns1)
      .mockReturnValueOnce(mpIns2);
    const out = await createMatch({
      userId: "u1", gameId: "g1", playerIds: ["p1", "p2"], location: "Frisco",
    });
    expect(out.id).toBe("m1");
    expect(mockInsert).toHaveBeenCalledTimes(3);
    const v1 = (mpIns1.values as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const v2 = (mpIns2.values as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(v1).toMatchObject({ matchId: "m1", playerId: "p1", score: 0, position: 0 });
    expect(v2).toMatchObject({ matchId: "m1", playerId: "p2", score: 0, position: 1 });
  });
});

describe("incrementScore", () => {
  it("sets score via a greatest(score + delta, 0) SQL expression", async () => {
    const ch = updateChain([{ score: 2 }]);
    mockUpdate.mockReturnValue(ch);
    const out = await incrementScore("m1", "p1", 1);
    expect(out).toEqual({ score: 2 });
    const setArg = ch.set.mock.calls[0][0] as Record<string, { kind?: string }>;
    expect(setArg.score?.kind).toBe("sql");
  });

  it("returns null when the player is not in the match", async () => {
    const ch = updateChain([]);
    mockUpdate.mockReturnValue(ch);
    expect(await incrementScore("m1", "p-x", 1)).toBeNull();
  });
});

describe("updateMatch", () => {
  it("sets the location and bumps updatedAt, scoped to the owner", async () => {
    const ch = updateChain([{ id: "m1", userId: "u1", location: "Legacy West" }]);
    mockUpdate.mockReturnValue(ch);
    const out = await updateMatch("m1", "u1", { location: "Legacy West" });
    expect(out?.location).toBe("Legacy West");
    const setArg = ch.set.mock.calls[0][0] as Record<string, unknown>;
    expect(setArg).toMatchObject({ location: "Legacy West" });
    expect(setArg).toHaveProperty("updatedAt");
    expect((eq as ReturnType<typeof vi.fn>).mock.calls.some(
      (call) => call[1] === "u1",
    )).toBe(true);
    expect(and).toHaveBeenCalled();
  });

  it("clears the location when passed null", async () => {
    const ch = updateChain([{ id: "m1", location: null }]);
    mockUpdate.mockReturnValue(ch);
    await updateMatch("m1", "u1", { location: null });
    expect(ch.set.mock.calls[0][0]).toMatchObject({ location: null });
  });

  it("leaves location untouched when the patch omits it", async () => {
    const ch = updateChain([{ id: "m1", location: "Frisco" }]);
    mockUpdate.mockReturnValue(ch);
    await updateMatch("m1", "u1", {});
    expect(ch.set.mock.calls[0][0]).not.toHaveProperty("location");
  });

  it("returns null when the match is missing or owned by someone else", async () => {
    const ch = updateChain([]);
    mockUpdate.mockReturnValue(ch);
    expect(await updateMatch("m1", "u2", { location: "x" })).toBeNull();
  });
});

describe("decideWinner", () => {
  it("returns the single top scorer", () => {
    expect(decideWinner([
      { playerId: "p1", score: 1 },
      { playerId: "p2", score: 2 },
    ])).toBe("p2");
  });

  it("returns null when the top score is shared (a tie)", () => {
    expect(decideWinner([
      { playerId: "p1", score: 3 },
      { playerId: "p2", score: 3 },
      { playerId: "p3", score: 1 },
    ])).toBeNull();
  });

  it("treats an untouched 0-0 board as a tie, not a p1 win", () => {
    expect(decideWinner([
      { playerId: "p1", score: 0 },
      { playerId: "p2", score: 0 },
    ])).toBeNull();
  });

  it("ignores roster order", () => {
    expect(decideWinner([
      { playerId: "p1", score: 5 },
      { playerId: "p2", score: 4 },
    ])).toBe("p1");
  });

  it("returns null for an empty roster", () => {
    expect(decideWinner([])).toBeNull();
  });
});

describe("finishMatch", () => {
  it("updates only live rows, setting the computed winner + final status", async () => {
    mockSelect.mockReturnValue(chain([
      { playerId: "p1", score: 1 },
      { playerId: "p2", score: 2 },
    ]));
    const ch = updateChain([{ id: "m1", status: "final", winnerPlayerId: "p2" }]);
    mockUpdate.mockReturnValue(ch);
    const out = await finishMatch("m1", "u1");
    expect(out?.status).toBe("final");
    const setArg = ch.set.mock.calls[0][0] as Record<string, unknown>;
    expect(setArg).toMatchObject({ status: "final", winnerPlayerId: "p2" });
    expect(setArg).toHaveProperty("updatedAt");
    // where clause includes the status=live guard
    expect((eq as ReturnType<typeof vi.fn>).mock.calls.some(
      (call) => call[1] === "live",
    )).toBe(true);
    expect(and).toHaveBeenCalled();
  });

  it("stores a null winner when the scores are level", async () => {
    mockSelect.mockReturnValue(chain([
      { playerId: "p1", score: 2 },
      { playerId: "p2", score: 2 },
    ]));
    const ch = updateChain([{ id: "m1", status: "final", winnerPlayerId: null }]);
    mockUpdate.mockReturnValue(ch);
    const out = await finishMatch("m1", "u1");
    expect(out?.winnerPlayerId).toBeNull();
    const setArg = ch.set.mock.calls[0][0] as Record<string, unknown>;
    expect(setArg).toMatchObject({ status: "final", winnerPlayerId: null });
  });

  it("returns null when the match was already final", async () => {
    mockSelect.mockReturnValue(chain([{ playerId: "p1", score: 1 }]));
    const ch = updateChain([]);
    mockUpdate.mockReturnValue(ch);
    expect(await finishMatch("m1", "u1")).toBeNull();
  });
});

describe("reopenMatch", () => {
  it("sets status live and clears the winner, only from final", async () => {
    const ch = updateChain([{ id: "m1", status: "live", winnerPlayerId: null }]);
    mockUpdate.mockReturnValue(ch);
    const out = await reopenMatch("m1", "u1");
    expect(out?.status).toBe("live");
    const setArg = ch.set.mock.calls[0][0] as Record<string, unknown>;
    expect(setArg).toMatchObject({ status: "live", winnerPlayerId: null });
    expect((eq as ReturnType<typeof vi.fn>).mock.calls.some(
      (call) => call[1] === "final",
    )).toBe(true);
  });
});

describe("playerHasMatches", () => {
  it("true when a match_players row exists", async () => {
    mockSelect.mockReturnValue(chain([{ id: "mp1" }]));
    expect(await playerHasMatches("p1")).toBe(true);
  });
  it("false when none exists", async () => {
    mockSelect.mockReturnValue(chain([]));
    expect(await playerHasMatches("p1")).toBe(false);
  });
});

describe("listMatches", () => {
  it("passes undefined where when no filters and orders desc with limit", async () => {
    const c = chain([]);
    mockSelect.mockReturnValue(c);
    await listMatches({ limit: 50 });
    expect((c.where as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBeUndefined();
    expect(c.orderBy).toHaveBeenCalled();
    expect((c.limit as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe(50);
  });

  it("combines gameId, status, and cursor filters with and()", async () => {
    const c = chain([]);
    mockSelect.mockReturnValue(c);
    await listMatches({
      gameId: "g1", status: "final", limit: 10, cursor: new Date("2026-01-01"),
    });
    const whereArg = (c.where as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      and?: unknown[];
    };
    expect(whereArg.and).toHaveLength(3);
  });
});
