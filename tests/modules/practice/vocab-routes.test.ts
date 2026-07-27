import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

const m = vi.hoisted(() => ({
  upsertLocation: vi.fn(),
  getSessionById: vi.fn(),
  createVocabSession: vi.fn(),
  getVocabSession: vi.fn(),
  vocabSessionSummary: vi.fn(),
  generateVocabSession: vi.fn(),
  vocabPreviewCounts: vi.fn(),
  isVocabCard: vi.fn(),
  applyReview: vi.fn(),
}));

// Mock every repo routes.ts imports so nothing touches the DB.
vi.mock("@/modules/practice/prescription-repo", () => ({ getPrescription: vi.fn(), upsertPrescription: vi.fn(), deletePrescription: vi.fn() }));
vi.mock("@/modules/practice/locations-repo", () => ({ listLocations: vi.fn(), upsertLocation: m.upsertLocation, deleteLocation: vi.fn(), normalizeLocationName: (s: string) => s.trim().toLowerCase() }));
vi.mock("@/modules/practice/sessions-repo", () => ({ createSession: vi.fn(), getSessionById: m.getSessionById, listSessions: vi.fn(), markSessionCompleted: vi.fn(), deleteSession: vi.fn() }));
vi.mock("@/modules/practice/session-items-repo", () => ({ listItemsForSession: vi.fn(), syncSessionItem: vi.fn() }));
vi.mock("@/modules/practice/generator", () => ({ generateSessionItems: vi.fn() }));
vi.mock("@/modules/practice/items-repo", () => ({ listPracticeableItems: vi.fn(), getItemProgressDetail: vi.fn() }));
vi.mock("@/modules/practice/settings-repo", () => ({ getSettings: vi.fn(), updateSettings: vi.fn() }));
vi.mock("@/modules/practice/vocab-sessions-repo", () => ({ createVocabSession: m.createVocabSession, getVocabSession: m.getVocabSession, vocabSessionSummary: m.vocabSessionSummary }));
vi.mock("@/modules/practice/vocab-generator", () => ({ generateVocabSession: m.generateVocabSession, vocabPreviewCounts: m.vocabPreviewCounts, isVocabCard: m.isVocabCard }));
vi.mock("@/modules/practice/vocab-srs-repo", () => ({ applyReview: m.applyReview }));

vi.mock("@/modules/auth/middleware", () => ({
  optionalAuth: async (c: any, next: any) => { c.set("userId", c.req.header("X-Test-User") ?? null); c.set("tokenScopes", null); await next(); },
  requireAuth: async (c: any, next: any) => { const u = c.req.header("X-Test-User"); if (!u) return c.json({ error: "auth" }, 401); c.set("userId", u); c.set("tokenScopes", null); await next(); },
  requireScope: () => async (_c: any, next: any) => { await next(); },
  requireAdmin: () => async (_c: any, next: any) => { await next(); },
}));

import { practiceRoutes } from "@/modules/practice/routes";

beforeEach(() => vi.clearAllMocks());
const app = new Hono().route("/api/practice", practiceRoutes);
const SID = "11111111-1111-1111-1111-111111111111";
const WID = "22222222-2222-2222-2222-222222222222";

describe("POST /vocab/sessions", () => {
  it("401 without auth", async () => {
    const res = await app.request("/api/practice/vocab/sessions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ locationName: "Home", n: 5 }) });
    expect(res.status).toBe(401);
  });

  it("creates a vocab session with the generated cards", async () => {
    m.upsertLocation.mockResolvedValue({ id: "loc1", name: "Home", normalized: "home" });
    m.generateVocabSession.mockResolvedValue([{ itemId: WID, word: "ephemeral", level: 0, dueAt: null }]);
    m.createVocabSession.mockResolvedValue({ id: SID, mode: "vocab", locationName: "Home", nItemsRequested: 5 });
    const res = await app.request("/api/practice/vocab/sessions", { method: "POST", headers: { "Content-Type": "application/json", "X-Test-User": "u1" }, body: JSON.stringify({ locationName: "Home", n: 5 }) });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.session.mode).toBe("vocab");
    expect(body.cards).toHaveLength(1);
  });

  it("422 no_vocab_items when the pool is empty", async () => {
    m.upsertLocation.mockResolvedValue({ id: "loc1", name: "Home", normalized: "home" });
    m.generateVocabSession.mockResolvedValue([]);
    m.vocabPreviewCounts.mockResolvedValue({ dueAvailable: 0, newAvailable: 0 });
    const res = await app.request("/api/practice/vocab/sessions", { method: "POST", headers: { "Content-Type": "application/json", "X-Test-User": "u1" }, body: JSON.stringify({ locationName: "Home", n: 5 }) });
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("no_vocab_items");
    expect(m.createVocabSession).not.toHaveBeenCalled();
  });

  // SHAN-434: locationName is trimmed at the validator so it stays aligned
  // with the /vocab/preview query (both feed the same normalized SRS lookup).
  it("400 on a whitespace-only locationName", async () => {
    const res = await app.request("/api/practice/vocab/sessions", { method: "POST", headers: { "Content-Type": "application/json", "X-Test-User": "u1" }, body: JSON.stringify({ locationName: "   ", n: 5 }) });
    expect(res.status).toBe(400);
    expect(m.upsertLocation).not.toHaveBeenCalled();
  });

  it("trims surrounding whitespace before the location lookup", async () => {
    m.upsertLocation.mockResolvedValue({ id: "loc1", name: "Home", normalized: "home" });
    m.generateVocabSession.mockResolvedValue([{ itemId: WID, word: "ephemeral", level: 0, dueAt: null }]);
    m.createVocabSession.mockResolvedValue({ id: SID, mode: "vocab", locationName: "Home", nItemsRequested: 5 });
    const res = await app.request("/api/practice/vocab/sessions", { method: "POST", headers: { "Content-Type": "application/json", "X-Test-User": "u1" }, body: JSON.stringify({ locationName: "  Home  ", n: 5 }) });
    expect(res.status).toBe(201);
    expect(m.upsertLocation).toHaveBeenCalledWith("u1", "Home");
  });
});

describe("POST /vocab/reviews", () => {
  it("grades a card in an owned vocab session", async () => {
    m.getSessionById.mockResolvedValue({ id: SID, userId: "u1", mode: "vocab", locationId: "loc1", locationName: "Home", locationNormalized: "home" });
    m.isVocabCard.mockResolvedValue(true);
    m.applyReview.mockResolvedValue({ level: 1, dueAt: null, memorized: false, longTermMemorized: false });
    const res = await app.request("/api/practice/vocab/reviews", { method: "POST", headers: { "Content-Type": "application/json", "X-Test-User": "u1" }, body: JSON.stringify({ sessionId: SID, itemId: WID, grade: "remember" }) });
    expect(res.status).toBe(200);
    expect(m.applyReview).toHaveBeenCalledWith(expect.objectContaining({ sessionId: SID, itemId: WID, grade: "remember", locationNormalized: "home" }));
  });

  it("404 when the session is not a vocab session the user owns", async () => {
    m.getSessionById.mockResolvedValue(null);
    const res = await app.request("/api/practice/vocab/reviews", { method: "POST", headers: { "Content-Type": "application/json", "X-Test-User": "u1" }, body: JSON.stringify({ sessionId: SID, itemId: WID, grade: "remember" }) });
    expect(res.status).toBe(404);
    expect(m.applyReview).not.toHaveBeenCalled();
  });

  it("404 'Item not in session' when itemId is not a vocabulary card", async () => {
    m.getSessionById.mockResolvedValue({ id: SID, userId: "u1", mode: "vocab", locationId: "loc1", locationName: "Home", locationNormalized: "home" });
    m.isVocabCard.mockResolvedValue(false);
    const res = await app.request("/api/practice/vocab/reviews", { method: "POST", headers: { "Content-Type": "application/json", "X-Test-User": "u1" }, body: JSON.stringify({ sessionId: SID, itemId: WID, grade: "remember" }) });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("Item not in session");
    expect(m.applyReview).not.toHaveBeenCalled();
  });

  it("404 when the session is workout mode", async () => {
    m.getSessionById.mockResolvedValue({ id: SID, userId: "u1", mode: "workout", locationNormalized: null });
    const res = await app.request("/api/practice/vocab/reviews", { method: "POST", headers: { "Content-Type": "application/json", "X-Test-User": "u1" }, body: JSON.stringify({ sessionId: SID, itemId: WID, grade: "forget" }) });
    expect(res.status).toBe(404);
  });
});

describe("GET /vocab/preview", () => {
  it("returns due + new counts", async () => {
    m.vocabPreviewCounts.mockResolvedValue({ dueAvailable: 3, newAvailable: 12 });
    const res = await app.request("/api/practice/vocab/preview?locationName=Home&n=5", { headers: { "X-Test-User": "u1" } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ dueAvailable: 3, newAvailable: 12 });
  });
});

describe("GET /vocab/sessions/:id", () => {
  it("404 when not found", async () => {
    m.getVocabSession.mockResolvedValue(null);
    const res = await app.request(`/api/practice/vocab/sessions/${SID}`, { headers: { "X-Test-User": "u1" } });
    expect(res.status).toBe(404);
  });
  it("returns session + cards", async () => {
    m.getVocabSession.mockResolvedValue({ session: { id: SID, mode: "vocab" }, cards: [{ itemId: WID }] });
    const res = await app.request(`/api/practice/vocab/sessions/${SID}`, { headers: { "X-Test-User": "u1" } });
    expect(res.status).toBe(200);
    expect((await res.json()).cards).toHaveLength(1);
  });
});
