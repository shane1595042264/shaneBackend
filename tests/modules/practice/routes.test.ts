import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

const mocks = vi.hoisted(() => ({
  prescriptions: { get: vi.fn(), upsert: vi.fn(), delete: vi.fn() },
  locations: { list: vi.fn(), upsert: vi.fn(), delete: vi.fn() },
  sessions: { create: vi.fn(), getById: vi.fn(), list: vi.fn(), markCompleted: vi.fn(), delete: vi.fn() },
  sessionItems: { list: vi.fn(), sync: vi.fn() },
  generator: vi.fn(),
  items: { listPracticeable: vi.fn(), getProgress: vi.fn() },
  settings: { get: vi.fn(), update: vi.fn() },
}));

vi.mock("@/modules/practice/prescription-repo", () => ({ getPrescription: mocks.prescriptions.get, upsertPrescription: mocks.prescriptions.upsert, deletePrescription: mocks.prescriptions.delete }));
vi.mock("@/modules/practice/locations-repo", () => ({ listLocations: mocks.locations.list, upsertLocation: mocks.locations.upsert, deleteLocation: mocks.locations.delete, normalizeLocationName: (s: string) => s.trim().toLowerCase() }));
vi.mock("@/modules/practice/sessions-repo", () => ({ createSession: mocks.sessions.create, getSessionById: mocks.sessions.getById, listSessions: mocks.sessions.list, markSessionCompleted: mocks.sessions.markCompleted, deleteSession: mocks.sessions.delete }));
vi.mock("@/modules/practice/session-items-repo", () => ({ listItemsForSession: mocks.sessionItems.list, syncSessionItem: mocks.sessionItems.sync }));
vi.mock("@/modules/practice/generator", () => ({ generateSessionItems: mocks.generator }));
vi.mock("@/modules/practice/items-repo", () => ({ listPracticeableItems: mocks.items.listPracticeable, getItemProgressDetail: mocks.items.getProgress }));
vi.mock("@/modules/practice/settings-repo", () => ({ getSettings: mocks.settings.get, updateSettings: mocks.settings.update }));

vi.mock("@/modules/auth/middleware", () => ({
  optionalAuth: async (c: any, next: any) => { c.set("userId", c.req.header("X-Test-User") ?? null); c.set("tokenScopes", null); await next(); },
  requireAuth: async (c: any, next: any) => { const u = c.req.header("X-Test-User"); if (!u) return c.json({ error: "auth" }, 401); c.set("userId", u); c.set("tokenScopes", null); await next(); },
  requireScope: () => async (_c: any, next: any) => { await next(); },
  requireAdmin: () => async (_c: any, next: any) => { await next(); },
}));

import { practiceRoutes } from "@/modules/practice/routes";

beforeEach(() => vi.clearAllMocks());
const app = new Hono().route("/api/practice", practiceRoutes);
const UUID = "11111111-1111-1111-1111-111111111111";

describe("PUT /prescriptions/:itemId", () => {
  it("upserts and returns the prescription", async () => {
    mocks.prescriptions.upsert.mockResolvedValue({ id: "p1", itemId: UUID, setMode: "time", setSize: 60, restSeconds: 30 });
    const res = await app.request(`/api/practice/prescriptions/${UUID}`, { method: "PUT", headers: { "Content-Type": "application/json", "X-Test-User": "u1" }, body: JSON.stringify({ setMode: "time", setSize: 60, restSeconds: 30 }) });
    expect(res.status).toBe(200);
    expect(mocks.prescriptions.upsert).toHaveBeenCalled();
  });
  it("400 on invalid set_size", async () => {
    const res = await app.request(`/api/practice/prescriptions/${UUID}`, { method: "PUT", headers: { "Content-Type": "application/json", "X-Test-User": "u1" }, body: JSON.stringify({ setMode: "time", setSize: -1, restSeconds: 30 }) });
    expect(res.status).toBe(400);
  });
});

describe("POST /sessions (generator mode)", () => {
  it("422 when generator finds no items", async () => {
    mocks.generator.mockResolvedValue([]);
    const res = await app.request("/api/practice/sessions", { method: "POST", headers: { "Content-Type": "application/json", "X-Test-User": "u1" }, body: JSON.stringify({ nItemsRequested: 5 }) });
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("no_items_match");
  });
  it("creates a session with the generated items", async () => {
    mocks.generator.mockResolvedValue([{ itemId: "i1", prescription: { setMode: "time", setSize: 60, restSeconds: 30 } }]);
    mocks.sessions.create.mockResolvedValue({ session: { id: "s1", userId: "u1", nItemsRequested: 1 }, itemIds: ["si1"] });
    const res = await app.request("/api/practice/sessions", { method: "POST", headers: { "Content-Type": "application/json", "X-Test-User": "u1" }, body: JSON.stringify({ nItemsRequested: 1, categoryFilter: "dance_move" }) });
    expect(res.status).toBe(201);
  });
});

describe("POST /sessions (explicit mode)", () => {
  it("rejects when an item has no prescription", async () => {
    mocks.prescriptions.get.mockResolvedValue(null);
    const res = await app.request("/api/practice/sessions", { method: "POST", headers: { "Content-Type": "application/json", "X-Test-User": "u1" }, body: JSON.stringify({ itemIds: [UUID] }) });
    expect(res.status).toBe(400);
  });
});

describe("POST /session-items/:id/sync", () => {
  it("accepts a sendBeacon-shaped body", async () => {
    mocks.sessionItems.sync.mockResolvedValue({ id: "si1", setsCompleted: 3 });
    const res = await app.request(`/api/practice/session-items/${UUID}/sync`, { method: "POST", headers: { "Content-Type": "application/json", "X-Test-User": "u1" }, body: JSON.stringify({ setsCompleted: 3, timerState: { phase: "rest", status: "running", currentSet: 4, elapsedSeconds: 0 } }) });
    expect(res.status).toBe(200);
  });
  it("404 when not owned by caller", async () => {
    mocks.sessionItems.sync.mockResolvedValue(null);
    const res = await app.request(`/api/practice/session-items/${UUID}/sync`, { method: "POST", headers: { "Content-Type": "application/json", "X-Test-User": "u1" }, body: JSON.stringify({ setsCompleted: 1 }) });
    expect(res.status).toBe(404);
  });
});

describe("GET /items", () => {
  it("returns the joined view", async () => {
    mocks.items.listPracticeable.mockResolvedValue([{ itemId: "i1", word: "X", totalStrikes: 3 }]);
    const res = await app.request("/api/practice/items", { headers: { "X-Test-User": "u1" } });
    expect(res.status).toBe(200);
    expect((await res.json()).items).toHaveLength(1);
  });
});

describe("GET /items/:itemId/progress", () => {
  it("404 when item not found", async () => {
    mocks.items.getProgress.mockResolvedValue(null);
    const res = await app.request(`/api/practice/items/${UUID}/progress`, { headers: { "X-Test-User": "u1" } });
    expect(res.status).toBe(404);
  });
});
