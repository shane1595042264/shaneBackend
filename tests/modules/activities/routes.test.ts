import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

const { mockSelect } = vi.hoisted(() => ({ mockSelect: vi.fn() }));

vi.mock("@/db/client", () => ({ db: { select: mockSelect } }));
vi.mock("@/db/schema", () => ({
  activities: { id: "id_col", date: "date_col", source: "source_col", type: "type_col", data: "data_col" },
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

beforeEach(() => vi.clearAllMocks());

const app = new Hono().route("/api/activities", activitiesRoutes);

describe("GET /api/activities/:date", () => {
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

  it("dedups rows that share (source, type, data.id), keeping the first", async () => {
    mockSelect.mockReturnValue(chain([
      { id: "row1", date: "2026-05-06", source: "google_calendar", type: "calendar_event", data: { id: "evt-A", title: "Standup", location: "Room 1" } },
      { id: "row2", date: "2026-05-06", source: "google_calendar", type: "calendar_event", data: { id: "evt-A", title: "Standup", location: "Room 1, +Zoom" } },
      { id: "row3", date: "2026-05-06", source: "google_calendar", type: "calendar_event", data: { id: "evt-B", title: "Lunch" } },
      { id: "row4", date: "2026-05-06", source: "google_calendar", type: "calendar_event", data: { id: "evt-A", title: "Standup", location: "Room 2" } },
    ]));
    const res = await app.request("/api/activities/2026-05-06");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.activities).toHaveLength(2);
    expect(body.activities[0].id).toBe("row1");
    expect(body.activities[1].id).toBe("row3");
  });

  it("does not dedup rows whose data lacks an id", async () => {
    mockSelect.mockReturnValue(chain([
      { id: "r1", date: "2026-05-06", source: "owntracks", type: "place_enter", data: { timestamp: "2026-05-06T12:00:00Z" } },
      { id: "r2", date: "2026-05-06", source: "owntracks", type: "place_enter", data: { timestamp: "2026-05-06T13:00:00Z" } },
    ]));
    const res = await app.request("/api/activities/2026-05-06");
    expect(res.status).toBe(200);
    expect((await res.json()).activities).toHaveLength(2);
  });
});
