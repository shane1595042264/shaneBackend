import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

const { mockGetSettings, mockUpdateSettings } = vi.hoisted(() => ({
  mockGetSettings: vi.fn(),
  mockUpdateSettings: vi.fn(),
}));

vi.mock("@/modules/practice/settings-repo", () => ({
  getSettings: mockGetSettings,
  updateSettings: mockUpdateSettings,
}));

vi.mock("@/modules/auth/middleware", () => ({
  optionalAuth: async (c: any, next: any) => { c.set("userId", c.req.header("X-Test-User") ?? null); c.set("tokenScopes", null); await next(); },
  requireAuth: async (c: any, next: any) => { const u = c.req.header("X-Test-User"); if (!u) return c.json({ error: "auth" }, 401); c.set("userId", u); c.set("tokenScopes", null); await next(); },
  requireScope: () => async (_c: any, next: any) => { await next(); },
  requireAdmin: () => async (c: any, next: any) => { if (c.req.header("X-Test-Admin") !== "1") return c.json({ error: "admin" }, 403); await next(); },
}));

import { practiceRoutes } from "@/modules/practice/routes";

beforeEach(() => vi.clearAllMocks());
const app = new Hono().route("/api/practice", practiceRoutes);

describe("GET /api/practice/settings", () => {
  it("returns the singleton row (public, no auth required)", async () => {
    mockGetSettings.mockResolvedValue({ setsPerStrike: 5, strikesPerLoadedLocation: 5, locationsToSolidify: 7, updatedAt: new Date("2026-05-25"), updatedBy: null });
    const res = await app.request("/api/practice/settings");
    expect(res.status).toBe(200);
    expect((await res.json()).settings.setsPerStrike).toBe(5);
  });
});

describe("PATCH /api/practice/settings", () => {
  it("requires auth", async () => {
    const res = await app.request("/api/practice/settings", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ setsPerStrike: 3 }) });
    expect(res.status).toBe(401);
  });
  it("requires admin", async () => {
    const res = await app.request("/api/practice/settings", { method: "PATCH", headers: { "Content-Type": "application/json", "X-Test-User": "u1" }, body: JSON.stringify({ setsPerStrike: 3 }) });
    expect(res.status).toBe(403);
  });
  it("updates and returns new settings when admin", async () => {
    mockUpdateSettings.mockResolvedValue({ setsPerStrike: 3, strikesPerLoadedLocation: 5, locationsToSolidify: 7, updatedAt: new Date(), updatedBy: "u1" });
    const res = await app.request("/api/practice/settings", { method: "PATCH", headers: { "Content-Type": "application/json", "X-Test-User": "u1", "X-Test-Admin": "1" }, body: JSON.stringify({ setsPerStrike: 3 }) });
    expect(res.status).toBe(200);
    expect(mockUpdateSettings).toHaveBeenCalledWith("u1", { setsPerStrike: 3 });
  });
  it("rejects thresholds outside 1..50", async () => {
    const res = await app.request("/api/practice/settings", { method: "PATCH", headers: { "Content-Type": "application/json", "X-Test-User": "u1", "X-Test-Admin": "1" }, body: JSON.stringify({ setsPerStrike: 0 }) });
    expect(res.status).toBe(400);
    expect(mockUpdateSettings).not.toHaveBeenCalled();
  });
  it("rejects empty body", async () => {
    const res = await app.request("/api/practice/settings", { method: "PATCH", headers: { "Content-Type": "application/json", "X-Test-User": "u1", "X-Test-Admin": "1" }, body: JSON.stringify({}) });
    expect(res.status).toBe(400);
  });
});
