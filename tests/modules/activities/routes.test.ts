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
});
