import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

const m = vi.hoisted(() => ({
  create: vi.fn(),
  update: vi.fn(),
  del: vi.fn(),
  list: vi.fn(),
  reorder: vi.fn(),
  search: vi.fn(),
}));

vi.mock("@/modules/skincare/repo", () => ({
  createSkincareProduct: m.create,
  updateSkincareProduct: m.update,
  deleteSkincareProduct: m.del,
  listSkincareProducts: m.list,
  reorderSkincareProducts: m.reorder,
}));
vi.mock("@/modules/skincare/search", () => ({ searchProducts: m.search }));
vi.mock("@/modules/shared/rate-limit", () => ({
  createPATRateLimit: () => async (_c: any, next: any) => { await next(); },
}));
vi.mock("@/modules/auth/middleware", () => ({
  requireAuth: async (c: any, next: any) => {
    const u = c.req.header("X-Test-User");
    if (!u) return c.json({ error: "auth" }, 401);
    c.set("userId", u);
    c.set("tokenScopes", null);
    await next();
  },
  requireScope: () => async (_c: any, next: any) => { await next(); },
}));

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
