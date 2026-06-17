// Covers the per-PAT rate limit applied to every requireScope-protected write
// endpoint in practice/routes.ts. JWTs (no tokenId) must bypass; PATs (tokenId
// set) must 429 once the per-bucket per-minute limit fills. Buckets are split
// so a runner's high-frequency sync calls don't lock out the rare config-write
// surfaces (and vice versa).
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { __resetRateLimitBuckets } from "@/modules/shared/rate-limit";

const mocks = vi.hoisted(() => ({
  prescriptions: { get: vi.fn(), upsert: vi.fn(), delete: vi.fn() },
  locations: { list: vi.fn(), upsert: vi.fn(), delete: vi.fn() },
  sessions: { create: vi.fn(), getById: vi.fn(), list: vi.fn(), markCompleted: vi.fn(), delete: vi.fn() },
  sessionItems: { list: vi.fn(), sync: vi.fn() },
  generator: vi.fn(),
  items: { listPracticeable: vi.fn(), getProgress: vi.fn() },
  settings: { get: vi.fn(), update: vi.fn() },
}));

vi.mock("@/modules/practice/prescription-repo", () => ({
  getPrescription: mocks.prescriptions.get,
  upsertPrescription: mocks.prescriptions.upsert,
  deletePrescription: mocks.prescriptions.delete,
}));
vi.mock("@/modules/practice/locations-repo", () => ({
  listLocations: mocks.locations.list,
  upsertLocation: mocks.locations.upsert,
  deleteLocation: mocks.locations.delete,
  normalizeLocationName: (s: string) => s.trim().toLowerCase(),
}));
vi.mock("@/modules/practice/sessions-repo", () => ({
  createSession: mocks.sessions.create,
  getSessionById: mocks.sessions.getById,
  listSessions: mocks.sessions.list,
  markSessionCompleted: mocks.sessions.markCompleted,
  deleteSession: mocks.sessions.delete,
}));
vi.mock("@/modules/practice/session-items-repo", () => ({
  listItemsForSession: mocks.sessionItems.list,
  syncSessionItem: mocks.sessionItems.sync,
}));
vi.mock("@/modules/practice/generator", () => ({ generateSessionItems: mocks.generator }));
vi.mock("@/modules/practice/items-repo", () => ({
  listPracticeableItems: mocks.items.listPracticeable,
  getItemProgressDetail: mocks.items.getProgress,
}));
vi.mock("@/modules/practice/settings-repo", () => ({
  getSettings: mocks.settings.get,
  updateSettings: mocks.settings.update,
}));

// X-Test-Token presence flips the request from "JWT" to "PAT" by setting
// tokenId. The real limiter only counts when tokenId is non-null.
vi.mock("@/modules/auth/middleware", () => ({
  optionalAuth: async (c: any, next: any) => {
    c.set("userId", c.req.header("X-Test-User") ?? null);
    const token = c.req.header("X-Test-Token");
    c.set("tokenScopes", token ? [] : null);
    c.set("tokenId", token ?? null);
    await next();
  },
  requireAuth: async (c: any, next: any) => {
    const u = c.req.header("X-Test-User");
    if (!u) return c.json({ error: "auth" }, 401);
    c.set("userId", u);
    const token = c.req.header("X-Test-Token");
    c.set("tokenScopes", token ? [] : null);
    c.set("tokenId", token ?? null);
    await next();
  },
  requireScope: () => async (_c: any, next: any) => { await next(); },
  requireAdmin: () => async (_c: any, next: any) => { await next(); },
}));

import { practiceRoutes } from "@/modules/practice/routes";

beforeEach(() => {
  vi.clearAllMocks();
  __resetRateLimitBuckets();
});

const app = new Hono().route("/api/practice", practiceRoutes);
const UUID = "11111111-1111-1111-1111-111111111111";

function patHeaders(token = "pat-test") {
  return {
    "Content-Type": "application/json",
    "X-Test-User": "u1",
    "X-Test-Token": token,
  };
}
function jwtHeaders() {
  return { "Content-Type": "application/json", "X-Test-User": "u1" };
}

describe("practice write rate limits (per PAT)", () => {
  it("prescriptions-write bucket 429s a PAT after 30 PUTs in a minute", async () => {
    mocks.prescriptions.upsert.mockResolvedValue({
      id: "p1", itemId: UUID, setMode: "time", setSize: 60, restSeconds: 30,
    });
    const headers = patHeaders();
    const body = JSON.stringify({ setMode: "time", setSize: 60, restSeconds: 30 });

    for (let i = 0; i < 30; i++) {
      const ok = await app.request(`/api/practice/prescriptions/${UUID}`, { method: "PUT", headers, body });
      expect(ok.status).toBe(200);
    }
    const blocked = await app.request(`/api/practice/prescriptions/${UUID}`, { method: "PUT", headers, body });
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("Retry-After")).toBe("60");
  });

  it("locations-write bucket 429s a PAT after 30 POSTs in a minute", async () => {
    mocks.locations.upsert.mockResolvedValue({ id: "l1", userId: "u1", name: "home" });
    const headers = patHeaders();
    const body = JSON.stringify({ name: "home" });

    for (let i = 0; i < 30; i++) {
      const r = await app.request("/api/practice/locations", { method: "POST", headers, body });
      expect(r.status).toBe(201);
    }
    const blocked = await app.request("/api/practice/locations", { method: "POST", headers, body });
    expect(blocked.status).toBe(429);
  });

  it("sessions-write bucket 429s a PAT after 30 POSTs in a minute", async () => {
    mocks.generator.mockResolvedValue([{ itemId: "i1", prescription: { setMode: "time", setSize: 60, restSeconds: 30 } }]);
    mocks.sessions.create.mockResolvedValue({ session: { id: "s1", userId: "u1", nItemsRequested: 1 }, itemIds: ["si1"] });
    const headers = patHeaders();
    const body = JSON.stringify({ nItemsRequested: 1 });

    for (let i = 0; i < 30; i++) {
      const r = await app.request("/api/practice/sessions", { method: "POST", headers, body });
      expect(r.status).toBe(201);
    }
    const blocked = await app.request("/api/practice/sessions", { method: "POST", headers, body });
    expect(blocked.status).toBe(429);
  });

  it("session-items-sync bucket allows 120 syncs per minute (higher than config buckets)", async () => {
    mocks.sessionItems.sync.mockResolvedValue({ id: "si1", setsCompleted: 1 });
    const headers = patHeaders();
    const body = JSON.stringify({ setsCompleted: 1 });

    for (let i = 0; i < 120; i++) {
      const r = await app.request(`/api/practice/session-items/${UUID}/sync`, { method: "POST", headers, body });
      expect(r.status).toBe(200);
    }
    const blocked = await app.request(`/api/practice/session-items/${UUID}/sync`, { method: "POST", headers, body });
    expect(blocked.status).toBe(429);
  });

  it("JWT requests with no tokenId bypass the limiter regardless of count", async () => {
    mocks.locations.upsert.mockResolvedValue({ id: "l1", userId: "u1", name: "home" });
    const headers = jwtHeaders();
    const body = JSON.stringify({ name: "home" });

    for (let i = 0; i < 40; i++) {
      const r = await app.request("/api/practice/locations", { method: "POST", headers, body });
      expect(r.status).toBe(201);
    }
  });

  it("isolates bucket per PAT id so one client doesn't lock out another", async () => {
    mocks.locations.upsert.mockResolvedValue({ id: "l1", userId: "u1", name: "home" });
    const body = JSON.stringify({ name: "home" });

    for (let i = 0; i < 30; i++) {
      const r = await app.request("/api/practice/locations", { method: "POST", headers: patHeaders("pat-alpha"), body });
      expect(r.status).toBe(201);
    }
    const alphaBlocked = await app.request("/api/practice/locations", { method: "POST", headers: patHeaders("pat-alpha"), body });
    expect(alphaBlocked.status).toBe(429);

    const beta = await app.request("/api/practice/locations", { method: "POST", headers: patHeaders("pat-beta"), body });
    expect(beta.status).toBe(201);
  });

  it("prescriptions bucket is independent from session-items-sync bucket", async () => {
    mocks.prescriptions.upsert.mockResolvedValue({
      id: "p1", itemId: UUID, setMode: "time", setSize: 60, restSeconds: 30,
    });
    mocks.sessionItems.sync.mockResolvedValue({ id: "si1", setsCompleted: 1 });
    const headers = patHeaders();

    // Burn the prescriptions bucket.
    for (let i = 0; i < 30; i++) {
      const r = await app.request(`/api/practice/prescriptions/${UUID}`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ setMode: "time", setSize: 60, restSeconds: 30 }),
      });
      expect(r.status).toBe(200);
    }
    const prescBlocked = await app.request(`/api/practice/prescriptions/${UUID}`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ setMode: "time", setSize: 60, restSeconds: 30 }),
    });
    expect(prescBlocked.status).toBe(429);

    // Sync still goes through — separate bucket, separate counter.
    const sync = await app.request(`/api/practice/session-items/${UUID}/sync`, {
      method: "POST",
      headers,
      body: JSON.stringify({ setsCompleted: 1 }),
    });
    expect(sync.status).toBe(200);
  });
});
