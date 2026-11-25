import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

const { mockSelect, mockHasAccess } = vi.hoisted(() => ({
  mockSelect: vi.fn(),
  mockHasAccess: vi.fn(),
}));

vi.mock("@/db/client", () => ({ db: { select: mockSelect } }));
vi.mock("@/db/schema", () => ({
  activities: { id: "id_col", createdAt: "created_at_col", date: "date_col", source: "source_col", type: "type_col", data: "data_col" },
}));
// The real requireJournalMembership runs; only the membership lookup and the
// token resolution are stubbed.
vi.mock("@/modules/journal/access-repo", () => ({ hasJournalAccess: mockHasAccess }));
vi.mock("@/modules/auth/middleware", () => ({
  optionalAuth: async (c: any, next: any) => {
    c.set("userId", c.req.header("X-Test-User") ?? null);
    await next();
  },
}));
vi.mock("drizzle-orm", () => ({
  eq: vi.fn((c, v) => ({ c, v })),
  asc: vi.fn((c) => ({ c, dir: "asc" })),
}));

function chain(rows: unknown[]) {
  const c: Record<string, unknown> = {};
  const t = Promise.resolve(rows);
  for (const m of ["from", "where", "orderBy"]) c[m] = vi.fn(() => c);
  Object.assign(c, { then: (r: any, j: any) => t.then(r, j) });
  return c;
}

import { activitiesRoutes } from "@/modules/activities/routes";

beforeEach(() => {
  vi.clearAllMocks();
  mockHasAccess.mockImplementation(async (userId: string | null) => userId === "member");
});

const routes = new Hono().route("/api/activities", activitiesRoutes);
// Every request below is a journal member's unless it says otherwise.
const app = {
  request: (path: string, headers: Record<string, string> = { "X-Test-User": "member" }) =>
    routes.request(path, { headers }),
};

describe("GET /api/activities/:date", () => {
  it("403s a signed-out caller without touching the DB", async () => {
    const res = await app.request("/api/activities/2026-05-03", {});
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("journal_access_required");
    expect(mockHasAccess).toHaveBeenCalledWith(null);
    expect(mockSelect).not.toHaveBeenCalled();
  });

  it("403s a signed-in user who is not a journal member", async () => {
    const res = await app.request("/api/activities/2026-05-03", { "X-Test-User": "stranger" });
    expect(res.status).toBe(403);
    expect(mockHasAccess).toHaveBeenCalledWith("stranger");
    expect(mockSelect).not.toHaveBeenCalled();
  });

  it("returns activities for the date", async () => {
    mockSelect.mockReturnValue(chain([
      { id: "a1", date: "2026-05-03", source: "github", type: "commit", data: { repo: "foo", message: "bar" } },
      { id: "a2", date: "2026-05-03", source: "strava", type: "run", data: { distanceMeters: 5000 } },
    ]));
    const res = await app.request("/api/activities/2026-05-03");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.activities).toHaveLength(2);
    expect(body.activities[0].source).toBe("github");
  });

  it("returns empty array for a date with no activity", async () => {
    mockSelect.mockReturnValue(chain([]));
    const res = await app.request("/api/activities/2026-05-03");
    expect(res.status).toBe(200);
    expect((await res.json()).activities).toEqual([]);
  });

  it("rejects malformed date with 400", async () => {
    const res = await app.request("/api/activities/not-a-date");
    expect(res.status).toBe(400);
  });

  it("rejects calendar-invalid date (2026-02-30) with 400 before hitting the DB", async () => {
    const res = await app.request("/api/activities/2026-02-30");
    expect(res.status).toBe(400);
    expect(mockSelect).not.toHaveBeenCalled();
  });

  it("rejects month 13 (2026-13-01) with 400 before hitting the DB", async () => {
    const res = await app.request("/api/activities/2026-13-01");
    expect(res.status).toBe(400);
    expect(mockSelect).not.toHaveBeenCalled();
  });

  it("dedups rows that share (source, type, data.id), keeping the latest sync", async () => {
    // Rows arrive in sync order (created_at, id); row4 is the newest copy of evt-A.
    mockSelect.mockReturnValue(chain([
      { id: "row1", date: "2026-05-06", source: "google_calendar", type: "calendar_event", data: { id: "evt-A", title: "Standup", startTime: "2026-05-06T10:00:00-05:00" } },
      { id: "row2", date: "2026-05-06", source: "google_calendar", type: "calendar_event", data: { id: "evt-A", title: "Standup", startTime: "2026-05-06T11:00:00-05:00" } },
      { id: "row3", date: "2026-05-06", source: "google_calendar", type: "calendar_event", data: { id: "evt-B", title: "Lunch", startTime: "2026-05-06T12:00:00-05:00" } },
      { id: "row4", date: "2026-05-06", source: "google_calendar", type: "calendar_event", data: { id: "evt-A", title: "Standup", startTime: "2026-05-06T14:00:00-05:00" } },
    ]));
    const res = await app.request("/api/activities/2026-05-06");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.activities.map((a: any) => a.id)).toEqual(["row3", "row4"]);
  });

  it("reads rows in sync order, not by the random uuid", async () => {
    const q = chain([]);
    mockSelect.mockReturnValue(q);
    await app.request("/api/activities/2026-05-06");
    expect(q.orderBy).toHaveBeenCalledWith(
      { c: "created_at_col", dir: "asc" },
      { c: "id_col", dir: "asc" },
    );
  });

  it("orders the day by when each activity happened, across sources and UTC offsets", async () => {
    mockSelect.mockReturnValue(chain([
      { id: "late-commit", date: "2026-05-06", source: "github", type: "commit", data: { sha: "b", timestamp: "2026-05-06T20:00:00Z" } },
      { id: "meeting", date: "2026-05-06", source: "google_calendar", type: "calendar_event", data: { id: "evt", startTime: "2026-05-06T09:00:00-05:00" } },
      { id: "early-commit", date: "2026-05-06", source: "github", type: "commit", data: { sha: "a", timestamp: "2026-05-06T13:30:00Z" } },
      { id: "stream", date: "2026-05-06", source: "twitch", type: "stream", data: { createdAt: "2026-05-06T18:00:00Z" } },
    ]));
    const res = await app.request("/api/activities/2026-05-06");
    // 09:00-05:00 is 14:00Z, so it sorts after the 13:30Z commit.
    expect((await res.json()).activities.map((a: any) => a.id)).toEqual([
      "early-commit", "meeting", "stream", "late-commit",
    ]);
  });

  it("puts rows with no usable time last, in sync order", async () => {
    mockSelect.mockReturnValue(chain([
      { id: "untimed-1", date: "2026-05-06", source: "wechat", type: "message", data: { chat: "x" } },
      { id: "timed", date: "2026-05-06", source: "github", type: "commit", data: { timestamp: "2026-05-06T12:00:00Z" } },
      { id: "bad-time", date: "2026-05-06", source: "strava", type: "run", data: { startTime: "not a date" } },
      { id: "untimed-2", date: "2026-05-06", source: "wechat", type: "message", data: { chat: "y" } },
    ]));
    const res = await app.request("/api/activities/2026-05-06");
    expect((await res.json()).activities.map((a: any) => a.id)).toEqual([
      "timed", "untimed-1", "bad-time", "untimed-2",
    ]);
  });

  it("does not dedup rows whose data lacks an id", async () => {
    mockSelect.mockReturnValue(chain([
      { id: "r1", date: "2026-05-06", source: "google_maps", type: "place_enter", data: { timestamp: "2026-05-06T12:00:00Z" } },
      { id: "r2", date: "2026-05-06", source: "google_maps", type: "place_enter", data: { timestamp: "2026-05-06T13:00:00Z" } },
    ]));
    const res = await app.request("/api/activities/2026-05-06");
    expect(res.status).toBe(200);
    expect((await res.json()).activities).toHaveLength(2);
  });
});
