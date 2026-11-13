import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

const m = vi.hoisted(() => ({
  create: vi.fn(),
  update: vi.fn(),
  del: vi.fn(),
  list: vi.fn(),
  reorder: vi.fn(),
  search: vi.fn(),
  MismatchError: class SkincareReorderMismatchError extends Error {
    constructor() {
      super("orderedIds must be exactly the products in this routine");
    }
  },
}));

vi.mock("@/modules/skincare/repo", () => ({
  createSkincareProduct: m.create,
  updateSkincareProduct: m.update,
  deleteSkincareProduct: m.del,
  listSkincareProducts: m.list,
  reorderSkincareProducts: m.reorder,
  SkincareReorderMismatchError: m.MismatchError,
}));
vi.mock("@/modules/skincare/search", () => ({ searchProducts: m.search }));
vi.mock("@/modules/shared/rate-limit", () => ({
  createPATRateLimit: () => async (_c: any, next: any) => { await next(); },
}));
// Fake only the token resolution; keep the real requireScope so the PAT gate
// is exercised as shipped. X-Test-Scopes marks the caller as a PAT.
vi.mock("@/modules/auth/middleware", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/modules/auth/middleware")>();
  return {
    ...actual,
    requireAuth: async (c: any, next: any) => {
      const u = c.req.header("X-Test-User");
      if (!u) return c.json({ error: "auth" }, 401);
      const scopes = c.req.header("X-Test-Scopes");
      c.set("userId", u);
      c.set("tokenScopes", scopes === undefined ? null : scopes.split(",").filter(Boolean));
      await next();
    },
  };
});

import { skincareRoutes } from "@/modules/skincare/routes";

beforeEach(() => vi.clearAllMocks());
const app = new Hono().route("/api/skincare", skincareRoutes);
const UUID = "11111111-1111-1111-1111-111111111111";

function post(body: unknown, user = "u1") {
  return app.request("/api/skincare", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Test-User": user },
    body: JSON.stringify(body),
  });
}
function patch(body: unknown, user = "u1") {
  return app.request(`/api/skincare/${UUID}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", "X-Test-User": user },
    body: JSON.stringify(body),
  });
}

const ROW = {
  id: UUID, userId: "u1", timeOfDay: "morning", name: "Cleanser", brand: null,
  imageUrl: null, position: 0, startedAt: new Date(), createdAt: new Date(), updatedAt: new Date(),
};

describe("POST /api/skincare — name/brand trimming (SHAN-434)", () => {
  it("401 without auth", async () => {
    const res = await app.request("/api/skincare", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ timeOfDay: "morning", name: "Cleanser" }),
    });
    expect(res.status).toBe(401);
  });

  it("400 on a whitespace-only name without hitting the repo", async () => {
    const res = await post({ timeOfDay: "morning", name: "   " });
    expect(res.status).toBe(400);
    expect(m.create).not.toHaveBeenCalled();
  });

  it("trims surrounding whitespace on name before persisting", async () => {
    m.create.mockResolvedValue({ ...ROW, name: "Cleanser" });
    const res = await post({ timeOfDay: "morning", name: "  Cleanser  " });
    expect(res.status).toBe(201);
    expect(m.create).toHaveBeenCalledWith(expect.objectContaining({ name: "Cleanser" }));
  });

  it("collapses a whitespace-only brand to null", async () => {
    m.create.mockResolvedValue({ ...ROW, name: "Cleanser", brand: null });
    const res = await post({ timeOfDay: "morning", name: "Cleanser", brand: "   " });
    expect(res.status).toBe(201);
    expect(m.create).toHaveBeenCalledWith(expect.objectContaining({ name: "Cleanser", brand: null }));
  });

  it("trims a real brand value", async () => {
    m.create.mockResolvedValue({ ...ROW, name: "Cleanser", brand: "CeraVe" });
    const res = await post({ timeOfDay: "morning", name: "Cleanser", brand: "  CeraVe  " });
    expect(res.status).toBe(201);
    expect(m.create).toHaveBeenCalledWith(expect.objectContaining({ brand: "CeraVe" }));
  });
});

describe("PATCH /api/skincare/:id — trimming (SHAN-434)", () => {
  it("a whitespace-only name is a no-op field and 400s (nothing to patch)", async () => {
    const res = await patch({ name: "   " });
    expect(res.status).toBe(400);
    expect(m.update).not.toHaveBeenCalled();
  });

  it("trims name before updating", async () => {
    m.update.mockResolvedValue({ ...ROW, name: "Toner" });
    const res = await patch({ name: "  Toner  " });
    expect(res.status).toBe(200);
    expect(m.update).toHaveBeenCalledWith(UUID, "u1", expect.objectContaining({ name: "Toner" }));
  });

  it("collapses a whitespace-only brand to null (clears it)", async () => {
    m.update.mockResolvedValue({ ...ROW });
    const res = await patch({ brand: "   " });
    expect(res.status).toBe(200);
    expect(m.update).toHaveBeenCalledWith(UUID, "u1", expect.objectContaining({ brand: null }));
  });
});

describe("POST /api/skincare/reorder — all or nothing (SHAN-580)", () => {
  const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  function reorder(body: unknown) {
    return app.request("/api/skincare/reorder", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Test-User": "u1" },
      body: JSON.stringify(body),
    });
  }

  it("200 with the reordered count when the id set matches the routine", async () => {
    m.reorder.mockResolvedValue(2);
    const res = await reorder({ timeOfDay: "morning", orderedIds: [B, A] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ reordered: 2 });
    expect(m.reorder).toHaveBeenCalledWith("u1", "morning", [B, A]);
  });

  it("400 when the repo rejects the id set (stale, foreign, or partial list)", async () => {
    m.reorder.mockRejectedValue(new m.MismatchError());
    const res = await reorder({ timeOfDay: "morning", orderedIds: [A] });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "orderedIds must be exactly the products in this routine",
    });
  });

  it("400 on duplicate ids without touching the repo", async () => {
    const res = await reorder({ timeOfDay: "morning", orderedIds: [A, A] });
    expect(res.status).toBe(400);
    expect(m.reorder).not.toHaveBeenCalled();
  });
});

describe("PAT reads need entries:write (SHAN-694)", () => {
  const reactionsPat = { "X-Test-User": "u1", "X-Test-Scopes": "reactions:write" };
  const entriesPat = { "X-Test-User": "u1", "X-Test-Scopes": "entries:write" };

  it("403s a reactions-only PAT on GET / before reading the routine", async () => {
    const res = await app.request("/api/skincare", { headers: reactionsPat });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("Token missing required scope: entries:write");
    expect(m.list).not.toHaveBeenCalled();
  });

  it("403s a reactions-only PAT on GET /search before calling the proxy", async () => {
    const res = await app.request("/api/skincare/search?q=cerave", { headers: reactionsPat });
    expect(res.status).toBe(403);
    expect(m.search).not.toHaveBeenCalled();
  });

  it("serves an entries:write PAT", async () => {
    m.list.mockResolvedValue([ROW]);
    m.search.mockResolvedValue([]);
    const list = await app.request("/api/skincare", { headers: entriesPat });
    expect(list.status).toBe(200);
    expect((await list.json()).morning).toHaveLength(1);
    const search = await app.request("/api/skincare/search?q=cerave", { headers: entriesPat });
    expect(search.status).toBe(200);
  });

  it("serves a browser session (JWT bypasses scopes)", async () => {
    m.list.mockResolvedValue([]);
    m.search.mockResolvedValue([]);
    expect((await app.request("/api/skincare", { headers: { "X-Test-User": "u1" } })).status).toBe(200);
    expect(
      (await app.request("/api/skincare/search?q=cerave", { headers: { "X-Test-User": "u1" } })).status,
    ).toBe(200);
  });
});
