import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

const { mockSelect, mockInsert } = vi.hoisted(() => ({
  mockSelect: vi.fn(),
  mockInsert: vi.fn(),
}));

vi.mock("@/db/client", () => ({ db: { select: mockSelect, insert: mockInsert } }));
vi.mock("@/db/schema", () => ({
  slotAssignments: { userId: "user_id_col", assignments: "assignments_col", updatedAt: "updated_at_col" },
}));
vi.mock("drizzle-orm", () => ({
  eq: vi.fn((c, v) => ({ c, v })),
}));
vi.mock("@/modules/auth/middleware", () => ({
  requireAuth: async (c: any, next: any) => {
    const u = c.req.header("X-Test-User");
    if (!u) return c.json({ error: "auth" }, 401);
    c.set("userId", u);
    await next();
  },
}));

// A thenable chain: every method returns the chain, and awaiting it resolves
// to `rows` (mirrors the drizzle query-builder shape the route awaits).
function selectChain(rows: unknown[]) {
  const c: Record<string, unknown> = {};
  const t = Promise.resolve(rows);
  for (const m of ["from", "where", "limit"]) c[m] = vi.fn(() => c);
  Object.assign(c, { then: (r: any, j: any) => t.then(r, j) });
  return c;
}

function insertChain() {
  const c: Record<string, unknown> = {};
  const t = Promise.resolve(undefined);
  for (const m of ["values", "onConflictDoUpdate"]) c[m] = vi.fn(() => c);
  Object.assign(c, { then: (r: any, j: any) => t.then(r, j) });
  return c;
}

import { slotRoutes } from "@/modules/slot-assignments/routes";

beforeEach(() => vi.clearAllMocks());
const app = new Hono().route("/api/slot-assignments", slotRoutes);

describe("GET /api/slot-assignments", () => {
  it("401 without auth", async () => {
    const res = await app.request("/api/slot-assignments");
    expect(res.status).toBe(401);
  });

  it("returns the stored assignments", async () => {
    mockSelect.mockReturnValue(selectChain([{ assignments: { "1": "app-h", "2": "app-he" } }]));
    const res = await app.request("/api/slot-assignments", { headers: { "X-Test-User": "u1" } });
    expect(res.status).toBe(200);
    expect((await res.json()).assignments).toEqual({ "1": "app-h", "2": "app-he" });
  });

  it("returns an empty object when the user has no row", async () => {
    mockSelect.mockReturnValue(selectChain([]));
    const res = await app.request("/api/slot-assignments", { headers: { "X-Test-User": "u1" } });
    expect(res.status).toBe(200);
    expect((await res.json()).assignments).toEqual({});
  });
});

describe("PUT /api/slot-assignments", () => {
  function put(body: unknown, user = "u1") {
    return app.request("/api/slot-assignments", {
      method: "PUT",
      headers: { "Content-Type": "application/json", "X-Test-User": user },
      body: JSON.stringify(body),
    });
  }

  it("401 without auth", async () => {
    const res = await app.request("/api/slot-assignments", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ assignments: { "1": "app-h" } }),
    });
    expect(res.status).toBe(401);
  });

  it("upserts and echoes the assignments", async () => {
    mockInsert.mockReturnValue(insertChain());
    const res = await put({ assignments: { "1": "app-h", "6": "app-c" } });
    expect(res.status).toBe(200);
    expect((await res.json()).assignments).toEqual({ "1": "app-h", "6": "app-c" });
    expect(mockInsert).toHaveBeenCalledOnce();
  });

  it("rejects more than 118 assignments with 400 before hitting the DB", async () => {
    const assignments: Record<string, string> = {};
    for (let i = 1; i <= 119; i++) assignments[String(i)] = `app-${i}`;
    const res = await put({ assignments });
    expect(res.status).toBe(400);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("accepts exactly 118 assignments", async () => {
    mockInsert.mockReturnValue(insertChain());
    const assignments: Record<string, string> = {};
    for (let i = 1; i <= 118; i++) assignments[String(i)] = `app-${i}`;
    const res = await put({ assignments });
    expect(res.status).toBe(200);
  });

  it("rejects an app id longer than 128 chars with 400", async () => {
    const res = await put({ assignments: { "1": "x".repeat(129) } });
    expect(res.status).toBe(400);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("rejects a non-numeric slot key with 400", async () => {
    const res = await put({ assignments: { abc: "app-h" } });
    expect(res.status).toBe(400);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("rejects an out-of-range atomic number with 400", async () => {
    const res = await put({ assignments: { "119": "app-h" } });
    expect(res.status).toBe(400);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("rejects duplicate app ids with 400", async () => {
    const res = await put({ assignments: { "1": "app-h", "2": "app-h" } });
    expect(res.status).toBe(400);
    expect(mockInsert).not.toHaveBeenCalled();
  });
});
