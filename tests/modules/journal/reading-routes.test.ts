import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

const { repo, gate } = vi.hoisted(() => ({
  repo: {
    entryIdForDate: vi.fn(),
    getReadingPosition: vi.fn(),
    listReadingPositions: vi.fn(),
    saveReadingPosition: vi.fn(),
  },
  gate: { member: true },
}));

vi.mock("@/modules/journal/reading-repo", () => repo);
vi.mock("@/modules/journal/access-middleware", () => ({
  requireJournalMembership: async (c: any, next: any) => {
    if (!gate.member) return c.json({ error: "Journal access required", code: "journal_access_required" }, 403);
    await next();
  },
}));
vi.mock("@/modules/auth/middleware", () => ({
  requireAuth: async (c: any, next: any) => {
    const u = c.req.header("X-Test-User");
    if (!u) return c.json({ error: "auth" }, 401);
    c.set("userId", u);
    c.set("tokenScopes", c.req.header("X-Test-Token") ? ["entries:write"] : null);
    await next();
  },
  requireBrowserSession: (feature: string) => async (c: any, next: any) => {
    if (c.get("tokenScopes") !== null) return c.json({ error: `${feature} requires a browser session, not a PAT` }, 403);
    await next();
  },
}));

import { journalReadingRoutes } from "@/modules/journal/reading-routes";

const app = new Hono().route("/api/journal/reading", journalReadingRoutes);
const send = (
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = { "X-Test-User": "u1" }
) =>
  app.request(path, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const ENTRY_ID = "22222222-2222-4222-8222-222222222222";
const anchor = { block: 7, offset: 0.4, text: "Networks drop responses, so clients retry." };
const saved = { date: "2026-10-13", progress: 0.42, anchor, updatedAt: "2026-10-19T15:00:00.000Z" };

beforeEach(() => {
  vi.clearAllMocks();
  gate.member = true;
});

describe("/api/journal/reading guards", () => {
  it("401s signed-out callers, 403s every PAT and 403s non-members", async () => {
    expect((await send("GET", "/api/journal/reading", undefined, {})).status).toBe(401);

    const pat = await send("PUT", "/api/journal/reading/2026-10-13", { progress: 0.5, anchor }, {
      "X-Test-User": "u1",
      "X-Test-Token": "t",
    });
    expect(pat.status).toBe(403);

    gate.member = false;
    const outsider = await send("GET", "/api/journal/reading/2026-10-13");
    expect(outsider.status).toBe(403);
    expect((await outsider.json()).code).toBe("journal_access_required");

    expect(repo.saveReadingPosition).not.toHaveBeenCalled();
    expect(repo.getReadingPosition).not.toHaveBeenCalled();
  });
});

describe("PUT /api/journal/reading/:date", () => {
  it("saves the caller's position on that entry and returns it", async () => {
    repo.entryIdForDate.mockResolvedValue(ENTRY_ID);
    repo.saveReadingPosition.mockResolvedValue(saved);
    const res = await send("PUT", "/api/journal/reading/2026-10-13", { progress: 0.42, anchor });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ position: saved });
    expect(repo.saveReadingPosition).toHaveBeenCalledWith({
      userId: "u1",
      entryId: ENTRY_ID,
      date: "2026-10-13",
      progress: 0.42,
      anchor,
    });
  });

  it("accepts moving backwards: a lower progress is saved like any other", async () => {
    repo.entryIdForDate.mockResolvedValue(ENTRY_ID);
    repo.saveReadingPosition.mockResolvedValue({ ...saved, progress: 0.05 });
    const res = await send("PUT", "/api/journal/reading/2026-10-13", {
      progress: 0.05,
      anchor: { block: 0, offset: 0, text: "" },
    });
    expect(res.status).toBe(200);
    expect(repo.saveReadingPosition.mock.calls[0][0].progress).toBe(0.05);
  });

  it("404s a date with no published entry", async () => {
    repo.entryIdForDate.mockResolvedValue(null);
    const res = await send("PUT", "/api/journal/reading/2026-10-13", { progress: 0.5, anchor });
    expect(res.status).toBe(404);
    expect(repo.saveReadingPosition).not.toHaveBeenCalled();
  });

  it("drops a lone surrogate the client's slice left at the end of the text", async () => {
    repo.entryIdForDate.mockResolvedValue(ENTRY_ID);
    repo.saveReadingPosition.mockResolvedValue(saved);
    const res = await send("PUT", "/api/journal/reading/2026-10-13", {
      progress: 0.5,
      anchor: { block: 1, offset: 0, text: "Trip recap \ud83c" },
    });
    expect(res.status).toBe(200);
    expect(repo.saveReadingPosition.mock.calls[0][0].anchor.text).toBe("Trip recap ");
  });

  it.each([
    ["progress above 1", { progress: 1.2, anchor }],
    ["negative progress", { progress: -0.1, anchor }],
    ["no anchor", { progress: 0.5 }],
    ["a fractional block", { progress: 0.5, anchor: { ...anchor, block: 1.5 } }],
    ["an offset past the cap", { progress: 0.5, anchor: { ...anchor, offset: 101 } }],
    ["text over 200 chars", { progress: 0.5, anchor: { ...anchor, text: "x".repeat(201) } }],
    ["an unknown key", { progress: 0.5, anchor, scrollY: 1200 }],
    ["an unknown anchor key", { progress: 0.5, anchor: { ...anchor, px: 900 } }],
  ])("400s %s", async (_label, body) => {
    const res = await send("PUT", "/api/journal/reading/2026-10-13", body);
    expect(res.status).toBe(400);
    expect(repo.saveReadingPosition).not.toHaveBeenCalled();
  });

  it("400s a malformed date before touching the database", async () => {
    const res = await send("PUT", "/api/journal/reading/not-a-date", { progress: 0.5, anchor });
    expect(res.status).toBe(400);
    expect(repo.entryIdForDate).not.toHaveBeenCalled();
  });
});

describe("GET /api/journal/reading/:date", () => {
  it("returns the caller's position, or null when they have not read it", async () => {
    repo.getReadingPosition.mockResolvedValueOnce(saved).mockResolvedValueOnce(null);
    const first = await send("GET", "/api/journal/reading/2026-10-13");
    expect(await first.json()).toEqual({ position: saved });
    expect(repo.getReadingPosition).toHaveBeenCalledWith("u1", "2026-10-13");

    const second = await send("GET", "/api/journal/reading/2026-10-12");
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ position: null });
  });
});

describe("GET /api/journal/reading", () => {
  it("lists the caller's positions, 20 by default", async () => {
    repo.listReadingPositions.mockResolvedValue([saved]);
    const res = await send("GET", "/api/journal/reading");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ positions: [saved] });
    expect(repo.listReadingPositions).toHaveBeenCalledWith("u1", 20);
  });

  it.each(["0", "101", "abc"])("400s limit=%s", async (limit) => {
    const res = await send("GET", `/api/journal/reading?limit=${limit}`);
    expect(res.status).toBe(400);
  });
});
