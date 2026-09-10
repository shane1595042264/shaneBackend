// tests/modules/practice/plans-routes.test.ts
// SHAN-468: the training-plans surface. Repo is mocked (no real DB in unit
// tests), so these assert routing, validation, ownership and the nested
// create fan-out rather than SQL.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

const m = vi.hoisted(() => ({
  slugTaken: vi.fn(),
  createPlan: vi.fn(),
  listPlans: vi.fn(),
  getPlanById: vi.fn(),
  getPlanByIcsToken: vi.fn(),
  getPlanTree: vi.fn(),
  updatePlan: vi.fn(),
  touchPlan: vi.fn(),
  deletePlan: vi.fn(),
  nextDayPosition: vi.fn(),
  createDay: vi.fn(),
  getDay: vi.fn(),
  updateDay: vi.fn(),
  deleteDay: vi.fn(),
  nextBlockPosition: vi.fn(),
  createBlock: vi.fn(),
  getBlock: vi.fn(),
  updateBlock: vi.fn(),
  deleteBlock: vi.fn(),
  replaceSteps: vi.fn(),
  upsertCompletion: vi.fn(),
  listCompletions: vi.fn(),
  deleteCompletion: vi.fn(),
}));

// Literal factory (no importOriginal): the real repo would pull @/db/client in.
vi.mock("@/modules/practice/plans-repo", () => ({
  PLAN_STATUSES: ["draft", "active", "archived"],
  PLAN_VISIBILITIES: ["private", "public"],
  BLOCK_KINDS: [
    "warmup",
    "skill",
    "drill",
    "strength",
    "conditioning",
    "mobility",
    "cooldown",
    "other",
  ],
  BLOCK_MODES: ["time", "reps"],
  ...m,
}));

vi.mock("@/modules/shared/rate-limit", () => ({
  createPATRateLimit: () => async (_c: unknown, next: () => Promise<void>) => {
    await next();
  },
}));

vi.mock("@/modules/auth/middleware", () => ({
  optionalAuth: async (c: any, next: () => Promise<void>) => {
    c.set("userId", c.req.header("X-Test-User") ?? null);
    c.set("tokenScopes", null);
    await next();
  },
  requireAuth: async (c: any, next: () => Promise<void>) => {
    const u = c.req.header("X-Test-User");
    if (!u) return c.json({ error: "auth" }, 401);
    c.set("userId", u);
    c.set("tokenScopes", null);
    await next();
  },
  requireScope: () => async (_c: unknown, next: () => Promise<void>) => {
    await next();
  },
}));

import { planRoutes } from "@/modules/practice/plans-routes";

const app = new Hono().route("/api/practice/plans", planRoutes);

const PLAN_ID = "11111111-1111-4111-8111-111111111111";
const DAY_ID = "22222222-2222-4222-8222-222222222222";
const BLOCK_ID = "33333333-3333-4333-8333-333333333333";
const OTHER_ID = "44444444-4444-4444-8444-444444444444";

const planRow = {
  id: PLAN_ID,
  userId: "u1",
  slug: "learn-the-windmill",
  title: "Learn the windmill",
  goal: "Clean 3 consecutive windmills",
  description: null,
  discipline: "bboy",
  status: "active",
  visibility: "private",
  startDate: "2026-09-08",
  daysPerWeek: 3,
  sessionTime: null,
  reminderMinutes: null,
  icsToken: null,
  createdAt: new Date("2026-09-08T00:00:00Z"),
  updatedAt: new Date("2026-09-08T00:00:00Z"),
};

const dayRow = { id: DAY_ID, planId: PLAN_ID, position: 1, label: "Day 1", weekday: 1, notes: null };
const blockRow = {
  id: BLOCK_ID,
  dayId: DAY_ID,
  position: 1,
  title: "Warm-up",
  kind: "warmup",
  mode: "time",
  targetSeconds: 600,
  targetReps: null,
  sets: 1,
  restSeconds: 0,
  notes: null,
};

function auth(user = "u1") {
  return { "X-Test-User": user, "Content-Type": "application/json" };
}

beforeEach(() => {
  vi.clearAllMocks();
  m.slugTaken.mockResolvedValue(false);
  m.createPlan.mockResolvedValue(planRow);
  m.getPlanById.mockResolvedValue(planRow);
  m.getPlanTree.mockImplementation(async (p: any) => ({ ...p, days: [] }));
  m.createDay.mockResolvedValue(dayRow);
  m.getDay.mockResolvedValue(dayRow);
  m.createBlock.mockResolvedValue(blockRow);
  m.getBlock.mockResolvedValue(blockRow);
  m.nextDayPosition.mockResolvedValue(1);
  m.nextBlockPosition.mockResolvedValue(1);
  m.replaceSteps.mockResolvedValue([]);
});

describe("POST /api/practice/plans", () => {
  it("requires auth", async () => {
    const res = await app.request("/api/practice/plans", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "x" }),
    });
    expect(res.status).toBe(401);
  });

  it("rejects a whitespace-only title", async () => {
    const res = await app.request("/api/practice/plans", {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ title: "   " }),
    });
    expect(res.status).toBe(400);
    expect(m.createPlan).not.toHaveBeenCalled();
  });

  it("creates a bare plan with a generated slug", async () => {
    const res = await app.request("/api/practice/plans", {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ title: "Learn the windmill", goal: "3 clean reps" }),
    });
    expect(res.status).toBe(201);
    expect(m.createPlan).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "u1",
        slug: "learn-the-windmill",
        title: "Learn the windmill",
        goal: "3 clean reps",
        status: "draft",
        visibility: "private",
      }),
    );
    expect(m.createDay).not.toHaveBeenCalled();
  });

  it("fans a nested days > blocks > steps payload out with array-order positions", async () => {
    const res = await app.request("/api/practice/plans", {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({
        title: "Windmill block",
        status: "active",
        days: [
          {
            label: "Day 1 — Foundation",
            weekday: 1,
            blocks: [
              {
                title: "Warm-up",
                kind: "warmup",
                mode: "time",
                targetSeconds: 600,
                steps: [
                  { text: "10 neck circles" },
                  { text: "10 hip openers", reps: 10 },
                  { text: "10 hollow rocks", reps: 10 },
                ],
              },
              { title: "Windmill drills", kind: "drill", mode: "reps", targetReps: 20, sets: 3 },
            ],
          },
          { label: "Day 2 — Conditioning" },
        ],
      }),
    });

    expect(res.status).toBe(201);
    expect(m.createDay).toHaveBeenCalledTimes(2);
    expect(m.createDay).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ planId: PLAN_ID, position: 1, label: "Day 1 — Foundation", weekday: 1 }),
    );
    expect(m.createDay).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ position: 2, label: "Day 2 — Conditioning", weekday: null }),
    );
    expect(m.createBlock).toHaveBeenCalledTimes(2);
    expect(m.createBlock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ position: 2, title: "Windmill drills", mode: "reps", sets: 3 }),
    );
    expect(m.replaceSteps).toHaveBeenCalledTimes(1);
    expect(m.replaceSteps).toHaveBeenCalledWith(BLOCK_ID, [
      { text: "10 neck circles", reps: null, durationSeconds: null },
      { text: "10 hip openers", reps: 10, durationSeconds: null },
      { text: "10 hollow rocks", reps: 10, durationSeconds: null },
    ]);
  });

  it("rejects an unknown block kind", async () => {
    const res = await app.request("/api/practice/plans", {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({
        title: "x",
        days: [{ label: "d", blocks: [{ title: "b", kind: "yoga-but-not-really" }] }],
      }),
    });
    expect(res.status).toBe(400);
  });
});

describe("GET /api/practice/plans/:planId", () => {
  it("returns the tree to its owner", async () => {
    const res = await app.request(`/api/practice/plans/${PLAN_ID}`, { headers: auth() });
    expect(res.status).toBe(200);
    expect((await res.json()).plan.id).toBe(PLAN_ID);
  });

  it("404s a private plan for another user", async () => {
    const res = await app.request(`/api/practice/plans/${PLAN_ID}`, { headers: auth("u2") });
    expect(res.status).toBe(404);
  });

  it("serves a public plan anonymously", async () => {
    m.getPlanById.mockResolvedValue({ ...planRow, visibility: "public" });
    const res = await app.request(`/api/practice/plans/${PLAN_ID}`);
    expect(res.status).toBe(200);
  });

  it("keeps the feed token out of a public plan read by anyone but the owner", async () => {
    m.getPlanById.mockResolvedValue({ ...planRow, visibility: "public", icsToken: "secret" });
    const mine = await (await app.request(`/api/practice/plans/${PLAN_ID}`, { headers: auth() })).json();
    expect(mine.plan.icsToken).toBe("secret");
    const theirs = await (await app.request(`/api/practice/plans/${PLAN_ID}`)).json();
    expect(theirs.plan.icsToken).toBeNull();
  });

  it("400s a non-uuid plan id", async () => {
    const res = await app.request("/api/practice/plans/not-a-uuid", { headers: auth() });
    expect(res.status).toBe(400);
  });
});

describe("plan mutations", () => {
  it("PATCH rejects an empty body", async () => {
    const res = await app.request(`/api/practice/plans/${PLAN_ID}`, {
      method: "PATCH",
      headers: auth(),
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect(m.updatePlan).not.toHaveBeenCalled();
  });

  it("PATCH updates status", async () => {
    m.updatePlan.mockResolvedValue({ ...planRow, status: "archived" });
    const res = await app.request(`/api/practice/plans/${PLAN_ID}`, {
      method: "PATCH",
      headers: auth(),
      body: JSON.stringify({ status: "archived" }),
    });
    expect(res.status).toBe(200);
    expect(m.updatePlan).toHaveBeenCalledWith(PLAN_ID, expect.objectContaining({ status: "archived" }));
  });

  it("DELETE 404s for a non-owner and never touches the repo", async () => {
    const res = await app.request(`/api/practice/plans/${PLAN_ID}`, {
      method: "DELETE",
      headers: auth("u2"),
    });
    expect(res.status).toBe(404);
    expect(m.deletePlan).not.toHaveBeenCalled();
  });
});

describe("days and blocks", () => {
  it("appends a day at the next position and touches the plan", async () => {
    m.nextDayPosition.mockResolvedValue(4);
    const res = await app.request(`/api/practice/plans/${PLAN_ID}/days`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ label: "Day 4" }),
    });
    expect(res.status).toBe(201);
    expect(m.createDay).toHaveBeenCalledWith(expect.objectContaining({ position: 4 }));
    expect(m.touchPlan).toHaveBeenCalledWith(PLAN_ID);
  });

  it("404s a day that belongs to a different plan", async () => {
    m.getDay.mockResolvedValue({ ...dayRow, planId: OTHER_ID });
    const res = await app.request(`/api/practice/plans/${PLAN_ID}/days/${DAY_ID}`, {
      method: "DELETE",
      headers: auth(),
    });
    expect(res.status).toBe(404);
    expect(m.deleteDay).not.toHaveBeenCalled();
  });

  it("404s a block that belongs to a different day", async () => {
    m.getBlock.mockResolvedValue({ ...blockRow, dayId: OTHER_ID });
    const res = await app.request(
      `/api/practice/plans/${PLAN_ID}/days/${DAY_ID}/blocks/${BLOCK_ID}`,
      { method: "DELETE", headers: auth() },
    );
    expect(res.status).toBe(404);
    expect(m.deleteBlock).not.toHaveBeenCalled();
  });

  it("PUT steps replaces the whole list", async () => {
    m.replaceSteps.mockResolvedValue([
      { id: "s1", blockId: BLOCK_ID, position: 1, text: "10 hip openers", reps: 10, durationSeconds: null },
    ]);
    const res = await app.request(
      `/api/practice/plans/${PLAN_ID}/days/${DAY_ID}/blocks/${BLOCK_ID}/steps`,
      {
        method: "PUT",
        headers: auth(),
        body: JSON.stringify({ steps: [{ text: "10 hip openers", reps: 10 }] }),
      },
    );
    expect(res.status).toBe(200);
    expect((await res.json()).steps).toHaveLength(1);
    expect(m.replaceSteps).toHaveBeenCalledWith(BLOCK_ID, [
      { text: "10 hip openers", reps: 10, durationSeconds: null },
    ]);
  });

  it("PUT steps accepts an empty list (clears the block)", async () => {
    const res = await app.request(
      `/api/practice/plans/${PLAN_ID}/days/${DAY_ID}/blocks/${BLOCK_ID}/steps`,
      { method: "PUT", headers: auth(), body: JSON.stringify({ steps: [] }) },
    );
    expect(res.status).toBe(200);
    expect(m.replaceSteps).toHaveBeenCalledWith(BLOCK_ID, []);
  });
});

describe("completions", () => {
  it("records a tally for a block in the plan", async () => {
    m.upsertCompletion.mockImplementation(async (v: any) => ({ id: "c1", ...v }));
    const res = await app.request(`/api/practice/plans/${PLAN_ID}/completions`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ blockId: BLOCK_ID, isoDate: "2026-09-08", setsCompleted: 3, elapsedSeconds: 620 }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.completion.setsCompleted).toBe(3);
    expect(body.completion.completedAt).not.toBeNull();
  });

  it("clears completedAt when completed=false but keeps the partial tally", async () => {
    m.upsertCompletion.mockImplementation(async (v: any) => ({ id: "c1", ...v }));
    const res = await app.request(`/api/practice/plans/${PLAN_ID}/completions`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ blockId: BLOCK_ID, isoDate: "2026-09-08", setsCompleted: 1, completed: false }),
    });
    expect(res.status).toBe(201);
    expect(m.upsertCompletion).toHaveBeenCalledWith(
      expect.objectContaining({ completedAt: null, setsCompleted: 1 }),
    );
  });

  it("404s a block that is not in this plan", async () => {
    m.getDay.mockResolvedValue({ ...dayRow, planId: OTHER_ID });
    const res = await app.request(`/api/practice/plans/${PLAN_ID}/completions`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ blockId: BLOCK_ID, isoDate: "2026-09-08" }),
    });
    expect(res.status).toBe(404);
    expect(m.upsertCompletion).not.toHaveBeenCalled();
  });

  it("rejects an impossible calendar date", async () => {
    const res = await app.request(`/api/practice/plans/${PLAN_ID}/completions`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ blockId: BLOCK_ID, isoDate: "2026-02-30" }),
    });
    expect(res.status).toBe(400);
  });

  it("deletes a tally row via query params (no DELETE body)", async () => {
    m.deleteCompletion.mockResolvedValue(true);
    const res = await app.request(
      `/api/practice/plans/${PLAN_ID}/completions?blockId=${BLOCK_ID}&isoDate=2026-09-08`,
      { method: "DELETE", headers: auth() },
    );
    expect(res.status).toBe(204);
    expect(m.deleteCompletion).toHaveBeenCalledWith("u1", BLOCK_ID, "2026-09-08");
  });

  it("lists only the caller's own tally, filtered by range", async () => {
    m.listCompletions.mockResolvedValue([]);
    const res = await app.request(
      `/api/practice/plans/${PLAN_ID}/completions?from=2026-09-01&to=2026-09-30`,
      { headers: auth() },
    );
    expect(res.status).toBe(200);
    expect(m.listCompletions).toHaveBeenCalledWith(PLAN_ID, "u1", {
      from: "2026-09-01",
      to: "2026-09-30",
    });
  });
});

describe("calendar settings (SHAN-473)", () => {
  it("PATCH accepts a session time and a reminder", async () => {
    m.updatePlan.mockResolvedValue({ ...planRow, sessionTime: "07:30", reminderMinutes: 30 });
    const res = await app.request(`/api/practice/plans/${PLAN_ID}`, {
      method: "PATCH",
      headers: auth(),
      body: JSON.stringify({ sessionTime: "07:30", reminderMinutes: 30 }),
    });
    expect(res.status).toBe(200);
    expect(m.updatePlan).toHaveBeenCalledWith(
      PLAN_ID,
      expect.objectContaining({ sessionTime: "07:30", reminderMinutes: 30 }),
    );
  });

  it("PATCH clears both with nulls", async () => {
    m.updatePlan.mockResolvedValue(planRow);
    const res = await app.request(`/api/practice/plans/${PLAN_ID}`, {
      method: "PATCH",
      headers: auth(),
      body: JSON.stringify({ sessionTime: null, reminderMinutes: null }),
    });
    expect(res.status).toBe(200);
  });

  it("PATCH rejects a malformed session time", async () => {
    const res = await app.request(`/api/practice/plans/${PLAN_ID}`, {
      method: "PATCH",
      headers: auth(),
      body: JSON.stringify({ sessionTime: "7:30am" }),
    });
    expect(res.status).toBe(400);
    expect(m.updatePlan).not.toHaveBeenCalled();
  });

  it("PATCH rejects a reminder further out than a day", async () => {
    const res = await app.request(`/api/practice/plans/${PLAN_ID}`, {
      method: "PATCH",
      headers: auth(),
      body: JSON.stringify({ reminderMinutes: 5000 }),
    });
    expect(res.status).toBe(400);
  });
});

describe("calendar token", () => {
  it("mints a token on first request", async () => {
    m.updatePlan.mockImplementation(async (_id: string, patch: any) => ({ ...planRow, ...patch }));
    const res = await app.request(`/api/practice/plans/${PLAN_ID}/calendar-token`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(201);
    expect((await res.json()).token).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("is idempotent so an already-subscribed URL keeps working", async () => {
    m.getPlanById.mockResolvedValue({ ...planRow, icsToken: "existing-token" });
    const res = await app.request(`/api/practice/plans/${PLAN_ID}/calendar-token`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).token).toBe("existing-token");
    expect(m.updatePlan).not.toHaveBeenCalled();
  });

  it("rotates on request", async () => {
    m.getPlanById.mockResolvedValue({ ...planRow, icsToken: "existing-token" });
    m.updatePlan.mockImplementation(async (_id: string, patch: any) => ({ ...planRow, ...patch }));
    const res = await app.request(`/api/practice/plans/${PLAN_ID}/calendar-token`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ rotate: true }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).token).not.toBe("existing-token");
  });

  it("404s for a non-owner without minting anything", async () => {
    const res = await app.request(`/api/practice/plans/${PLAN_ID}/calendar-token`, {
      method: "POST",
      headers: auth("u2"),
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(404);
    expect(m.updatePlan).not.toHaveBeenCalled();
  });

  it("revokes by clearing the column", async () => {
    m.updatePlan.mockResolvedValue(planRow);
    const res = await app.request(`/api/practice/plans/${PLAN_ID}/calendar-token`, {
      method: "DELETE",
      headers: auth(),
    });
    expect(res.status).toBe(204);
    expect(m.updatePlan).toHaveBeenCalledWith(PLAN_ID, { icsToken: null });
  });
});

describe("GET /api/practice/plans/:planId/calendar.ics", () => {
  const TOKEN = "55555555-5555-4555-8555-555555555555";

  beforeEach(() => {
    m.getPlanByIcsToken.mockResolvedValue({ ...planRow, icsToken: TOKEN });
    m.getPlanTree.mockImplementation(async (p: any) => ({
      ...p,
      days: [{ ...dayRow, blocks: [{ ...blockRow, steps: [] }] }],
    }));
  });

  it("serves the feed to an anonymous caller holding the token", async () => {
    const res = await app.request(
      `/api/practice/plans/${PLAN_ID}/calendar.ics?token=${TOKEN}`,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/calendar");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = await res.text();
    expect(body).toContain("BEGIN:VCALENDAR");
    expect(body).toContain("SUMMARY:Learn the windmill — Day 1 (bboy)");
  });

  it("404s a token that matches no plan", async () => {
    m.getPlanByIcsToken.mockResolvedValue(null);
    const res = await app.request(
      `/api/practice/plans/${PLAN_ID}/calendar.ics?token=${TOKEN}`,
    );
    expect(res.status).toBe(404);
  });

  it("404s when the token belongs to a different plan than the path", async () => {
    const res = await app.request(
      `/api/practice/plans/${OTHER_ID}/calendar.ics?token=${TOKEN}`,
    );
    expect(res.status).toBe(404);
  });

  it("400s without a token rather than falling back to the session", async () => {
    const res = await app.request(`/api/practice/plans/${PLAN_ID}/calendar.ics`, {
      headers: auth(),
    });
    expect(res.status).toBe(400);
    expect(m.getPlanTree).not.toHaveBeenCalled();
  });
});
