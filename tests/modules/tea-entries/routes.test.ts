import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { __resetPinAttempts } from "@/modules/tea-entries/pin-rate-limit";
import { __resetRateLimitBuckets } from "@/modules/shared/rate-limit";

const { mockCreate, mockGetById, mockListForAuthor, mockDelete, mockUpdate } = vi.hoisted(() => ({
  mockCreate: vi.fn(),
  mockGetById: vi.fn(),
  mockListForAuthor: vi.fn(),
  mockDelete: vi.fn(),
  mockUpdate: vi.fn(),
}));

vi.mock("@/modules/tea-entries/repo", () => ({
  createTeaEntry: mockCreate,
  getTeaEntryById: mockGetById,
  listTeaEntriesForAuthor: mockListForAuthor,
  deleteTeaEntry: mockDelete,
  updateTeaEntry: mockUpdate,
  // Keep verifyPin real — it's a 4-line constant-time compare with no DB deps.
  verifyPin: (a: string, b: string) => a === b,
}));

const { mockGetUniversalTeaPin } = vi.hoisted(() => ({
  mockGetUniversalTeaPin: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/modules/auth/user-prefs", () => ({
  getUserTimezone: vi.fn().mockResolvedValue("America/Chicago"),
  getUniversalTeaPin: mockGetUniversalTeaPin,
  DEFAULT_TIMEZONE: "America/Chicago",
}));

// X-Test-Token presence flips the request from "JWT" to "PAT" by setting
// tokenId. The PAT rate limiter only counts when tokenId is non-null, so
// existing tests (which never send the header) bypass it automatically.
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
  requireScope: () => async (_c: any, next: any) => {
    await next();
  },
}));

import { teaEntriesRoutes } from "@/modules/tea-entries/routes";

beforeEach(() => {
  vi.clearAllMocks();
  // Default: no universal PIN set. Individual tests opt in by overriding.
  mockGetUniversalTeaPin.mockResolvedValue(null);
  // Both rate limiters are module-level state; reset between cases so a
  // 429 hit in one test doesn't bleed into the next.
  __resetPinAttempts();
  __resetRateLimitBuckets();
});

const app = new Hono().route("/api/tea-entries", teaEntriesRoutes);
const VALID_UUID = "11111111-1111-1111-1111-111111111111";

describe("POST /api/tea-entries", () => {
  it("requires auth", async () => {
    const res = await app.request("/api/tea-entries", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "x", pin: "1234" }),
    });
    expect(res.status).toBe(401);
  });

  it("rejects PIN that isn't 4 digits", async () => {
    const res = await app.request("/api/tea-entries", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Test-User": "u1" },
      body: JSON.stringify({ content: "x", pin: "abc" }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects empty content", async () => {
    const res = await app.request("/api/tea-entries", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Test-User": "u1" },
      body: JSON.stringify({ content: "", pin: "1234" }),
    });
    expect(res.status).toBe(400);
  });

  it("creates and returns 201 with the entry (no PIN echoed in response)", async () => {
    mockCreate.mockResolvedValue({
      id: VALID_UUID,
      authorId: "u1",
      authorTimezone: "America/Chicago",
      title: null,
      content: "hello",
      pin: "1234",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const res = await app.request("/api/tea-entries", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Test-User": "u1" },
      body: JSON.stringify({ content: "hello", pin: "1234" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.entry.content).toBe("hello");
    expect(body.entry).not.toHaveProperty("pin");
  });
});

describe("GET /api/tea-entries", () => {
  it("requires auth", async () => {
    const res = await app.request("/api/tea-entries");
    expect(res.status).toBe(401);
  });

  it("returns the author's tea entries", async () => {
    mockListForAuthor.mockResolvedValue([{ id: VALID_UUID, title: "T" }]);
    const res = await app.request("/api/tea-entries", {
      headers: { "X-Test-User": "u1" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.entries).toHaveLength(1);
    expect(mockListForAuthor).toHaveBeenCalledWith("u1");
  });
});

describe("GET /api/tea-entries/public (removed — SHAN-334)", () => {
  // The public teaser feed leaked every author's title + excerpt to anonymous
  // viewers. It's gone: tea entries are private to their author, shareable
  // only via direct link + per-entry PIN. The literal /public now falls
  // through to the /:id UUID validator and is rejected — never a 200 list.
  it("does not serve a teaser list to anonymous callers", async () => {
    const res = await app.request("/api/tea-entries/public");
    expect(res.status).not.toBe(200);
    const body = await res.json().catch(() => ({}));
    expect(body).not.toHaveProperty("entries");
  });
});

describe("GET /api/tea-entries/:id", () => {
  it("404 when missing", async () => {
    mockGetById.mockResolvedValue(null);
    const res = await app.request(`/api/tea-entries/${VALID_UUID}`);
    expect(res.status).toBe(404);
  });

  it("returns entry + PIN to the author", async () => {
    mockGetById.mockResolvedValue({
      id: VALID_UUID,
      authorId: "u1",
      title: null,
      content: "secret",
      pin: "1234",
    });
    const res = await app.request(`/api/tea-entries/${VALID_UUID}`, {
      headers: { "X-Test-User": "u1" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.isAuthor).toBe(true);
    expect(body.entry.pin).toBe("1234");
    expect(body.entry.content).toBe("secret");
  });

  it("401 to non-author with no PIN header returns authorId for localStorage lookup", async () => {
    mockGetById.mockResolvedValue({
      id: VALID_UUID,
      authorId: "u-author",
      title: null,
      content: "secret",
      pin: "1234",
    });
    const res = await app.request(`/api/tea-entries/${VALID_UUID}`, {
      headers: { "X-Test-User": "u-other" },
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    // Frontend uses authorId to key its per-author PIN cache.
    expect(body.authorId).toBe("u-author");
  });

  it("403 to non-author with wrong PIN", async () => {
    mockGetById.mockResolvedValue({
      id: VALID_UUID,
      authorId: "u-author",
      title: null,
      content: "secret",
      pin: "1234",
    });
    const res = await app.request(`/api/tea-entries/${VALID_UUID}`, {
      headers: { "X-Test-User": "u-other", "X-Tea-Pin": "0000" },
    });
    expect(res.status).toBe(403);
  });

  it("200 to non-author with correct PIN, no PIN echoed", async () => {
    mockGetById.mockResolvedValue({
      id: VALID_UUID,
      authorId: "u-author",
      title: null,
      content: "secret",
      pin: "1234",
    });
    const res = await app.request(`/api/tea-entries/${VALID_UUID}`, {
      headers: { "X-Test-User": "u-other", "X-Tea-Pin": "1234" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.isAuthor).toBe(false);
    expect(body.entry.content).toBe("secret");
    expect(body.entry).not.toHaveProperty("pin");
  });

  it("anonymous with correct PIN can read", async () => {
    mockGetById.mockResolvedValue({
      id: VALID_UUID,
      authorId: "u-author",
      title: null,
      content: "secret",
      pin: "1234",
    });
    const res = await app.request(`/api/tea-entries/${VALID_UUID}`, {
      headers: { "X-Tea-Pin": "1234" },
    });
    expect(res.status).toBe(200);
  });

  it("rejects non-uuid id", async () => {
    const res = await app.request("/api/tea-entries/not-a-uuid");
    expect(res.status).toBe(400);
  });

  it("returns 429 with Retry-After once 10 wrong PIN attempts have stacked on the same entry", async () => {
    mockGetById.mockResolvedValue({
      id: VALID_UUID,
      authorId: "u-author",
      title: null,
      content: "secret",
      pin: "1234",
    });
    // First 9 wrong attempts return 403 — bucket has 1..9 strikes.
    for (let i = 0; i < 9; i++) {
      const res = await app.request(`/api/tea-entries/${VALID_UUID}`, {
        headers: { "X-Tea-Pin": "0000" },
      });
      expect(res.status).toBe(403);
    }
    // 10th wrong attempt trips the limiter — the route returns 429 instead
    // of "Incorrect PIN" 403 once the strike count hits the cap.
    const blocked = await app.request(`/api/tea-entries/${VALID_UUID}`, {
      headers: { "X-Tea-Pin": "0000" },
    });
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("Retry-After")).toBeTruthy();
    // Subsequent attempts within the window remain blocked without even
    // running verifyPin (isPinAttemptBlocked short-circuits).
    const stillBlocked = await app.request(`/api/tea-entries/${VALID_UUID}`, {
      headers: { "X-Tea-Pin": "0000" },
    });
    expect(stillBlocked.status).toBe(429);
  });

  it("a correct PIN clears the bucket so the next legitimate viewer is not blocked", async () => {
    mockGetById.mockResolvedValue({
      id: VALID_UUID,
      authorId: "u-author",
      title: null,
      content: "secret",
      pin: "1234",
    });
    // Burn 9 failed attempts (just below the cap).
    for (let i = 0; i < 9; i++) {
      const res = await app.request(`/api/tea-entries/${VALID_UUID}`, {
        headers: { "X-Tea-Pin": "0000" },
      });
      expect(res.status).toBe(403);
    }
    // Correct PIN succeeds and clears the bucket.
    const ok = await app.request(`/api/tea-entries/${VALID_UUID}`, {
      headers: { "X-Tea-Pin": "1234" },
    });
    expect(ok.status).toBe(200);
    // 10 more wrong attempts should be needed to re-arm the limiter — verify
    // the 1st post-clear failure is back to 403 (not 429).
    const stillOpen = await app.request(`/api/tea-entries/${VALID_UUID}`, {
      headers: { "X-Tea-Pin": "0000" },
    });
    expect(stillOpen.status).toBe(403);
  });

  it("non-author with author's universal PIN unlocks the entry", async () => {
    mockGetById.mockResolvedValue({
      id: VALID_UUID,
      authorId: "u-author",
      title: null,
      content: "secret",
      pin: "1234",
    });
    mockGetUniversalTeaPin.mockResolvedValue("9999");
    const res = await app.request(`/api/tea-entries/${VALID_UUID}`, {
      headers: { "X-Test-User": "u-other", "X-Tea-Pin": "9999" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.isAuthor).toBe(false);
    expect(body.entry.content).toBe("secret");
    expect(body.entry).not.toHaveProperty("pin");
    expect(mockGetUniversalTeaPin).toHaveBeenCalledWith("u-author");
  });

  it("per-entry PIN match short-circuits — does not look up universal PIN", async () => {
    mockGetById.mockResolvedValue({
      id: VALID_UUID,
      authorId: "u-author",
      title: null,
      content: "secret",
      pin: "1234",
    });
    const res = await app.request(`/api/tea-entries/${VALID_UUID}`, {
      headers: { "X-Test-User": "u-other", "X-Tea-Pin": "1234" },
    });
    expect(res.status).toBe(200);
    expect(mockGetUniversalTeaPin).not.toHaveBeenCalled();
  });

  it("wrong per-entry AND wrong universal both count as one strike, returns 403", async () => {
    mockGetById.mockResolvedValue({
      id: VALID_UUID,
      authorId: "u-author",
      title: null,
      content: "secret",
      pin: "1234",
    });
    mockGetUniversalTeaPin.mockResolvedValue("9999");
    const res = await app.request(`/api/tea-entries/${VALID_UUID}`, {
      headers: { "X-Test-User": "u-other", "X-Tea-Pin": "0000" },
    });
    expect(res.status).toBe(403);
    // After this one strike the bucket should still be unblocked; 9 more
    // wrong attempts must trip it (proving the universal-PIN miss did not
    // double-charge the limiter).
    for (let i = 0; i < 8; i++) {
      const r = await app.request(`/api/tea-entries/${VALID_UUID}`, {
        headers: { "X-Tea-Pin": "0000" },
      });
      expect(r.status).toBe(403);
    }
    const blocked = await app.request(`/api/tea-entries/${VALID_UUID}`, {
      headers: { "X-Tea-Pin": "0000" },
    });
    expect(blocked.status).toBe(429);
  });

  it("universal-PIN unlock clears the per-entry rate limit bucket", async () => {
    mockGetById.mockResolvedValue({
      id: VALID_UUID,
      authorId: "u-author",
      title: null,
      content: "secret",
      pin: "1234",
    });
    mockGetUniversalTeaPin.mockResolvedValue("9999");
    // Burn 9 strikes with a wrong PIN.
    for (let i = 0; i < 9; i++) {
      const r = await app.request(`/api/tea-entries/${VALID_UUID}`, {
        headers: { "X-Tea-Pin": "0000" },
      });
      expect(r.status).toBe(403);
    }
    // Universal-PIN unlock clears the bucket.
    const ok = await app.request(`/api/tea-entries/${VALID_UUID}`, {
      headers: { "X-Tea-Pin": "9999" },
    });
    expect(ok.status).toBe(200);
    // Next failure is a fresh strike — 403 not 429.
    const stillOpen = await app.request(`/api/tea-entries/${VALID_UUID}`, {
      headers: { "X-Tea-Pin": "0000" },
    });
    expect(stillOpen.status).toBe(403);
  });

  it("author requests bypass the limiter even after wrong-PIN attempts have piled up", async () => {
    mockGetById.mockResolvedValue({
      id: VALID_UUID,
      authorId: "u-author",
      title: null,
      content: "secret",
      pin: "1234",
    });
    // Trip the limiter from a non-author.
    for (let i = 0; i < 10; i++) {
      await app.request(`/api/tea-entries/${VALID_UUID}`, {
        headers: { "X-Tea-Pin": "0000" },
      });
    }
    // Author hit short-circuits before the limiter; should be 200 not 429.
    const authorHit = await app.request(`/api/tea-entries/${VALID_UUID}`, {
      headers: { "X-Test-User": "u-author" },
    });
    expect(authorHit.status).toBe(200);
  });
});

describe("PATCH /api/tea-entries/:id", () => {
  it("requires auth", async () => {
    const res = await app.request(`/api/tea-entries/${VALID_UUID}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "x" }),
    });
    expect(res.status).toBe(401);
  });

  it("rejects empty body (no fields)", async () => {
    const res = await app.request(`/api/tea-entries/${VALID_UUID}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "X-Test-User": "u1" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("rejects empty string content", async () => {
    const res = await app.request(`/api/tea-entries/${VALID_UUID}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "X-Test-User": "u1" },
      body: JSON.stringify({ content: "" }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects pin that isn't 4 digits", async () => {
    const res = await app.request(`/api/tea-entries/${VALID_UUID}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "X-Test-User": "u1" },
      body: JSON.stringify({ pin: "abcd" }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects content with in-flight upload placeholder", async () => {
    const res = await app.request(`/api/tea-entries/${VALID_UUID}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "X-Test-User": "u1" },
      body: JSON.stringify({ content: "![alt](uploading-abc-12345)" }),
    });
    expect(res.status).toBe(400);
  });

  it("404 when not author / not found (repo returns null)", async () => {
    mockUpdate.mockResolvedValue(null);
    const res = await app.request(`/api/tea-entries/${VALID_UUID}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "X-Test-User": "u-other" },
      body: JSON.stringify({ content: "x" }),
    });
    expect(res.status).toBe(404);
  });

  it("200 returns merged entry with PIN (author response shape)", async () => {
    mockUpdate.mockResolvedValue({
      id: VALID_UUID,
      authorId: "u1",
      authorTimezone: "America/Chicago",
      title: "edited",
      content: "new",
      pin: "5678",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const res = await app.request(`/api/tea-entries/${VALID_UUID}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "X-Test-User": "u1" },
      body: JSON.stringify({ title: "edited", content: "new", pin: "5678" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.isAuthor).toBe(true);
    expect(body.entry.title).toBe("edited");
    expect(body.entry.content).toBe("new");
    expect(body.entry.pin).toBe("5678");
    expect(mockUpdate).toHaveBeenCalledWith(VALID_UUID, "u1", {
      title: "edited",
      content: "new",
      pin: "5678",
    });
  });

  it("rejects non-uuid id", async () => {
    const res = await app.request(`/api/tea-entries/not-a-uuid`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "X-Test-User": "u1" },
      body: JSON.stringify({ content: "x" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("DELETE /api/tea-entries/:id", () => {
  it("requires auth", async () => {
    const res = await app.request(`/api/tea-entries/${VALID_UUID}`, { method: "DELETE" });
    expect(res.status).toBe(401);
  });

  it("204 when author deletes", async () => {
    mockDelete.mockResolvedValue(true);
    const res = await app.request(`/api/tea-entries/${VALID_UUID}`, {
      method: "DELETE",
      headers: { "X-Test-User": "u1" },
    });
    expect(res.status).toBe(204);
    expect(mockDelete).toHaveBeenCalledWith(VALID_UUID, "u1");
  });

  it("404 when not author / not found", async () => {
    mockDelete.mockResolvedValue(false);
    const res = await app.request(`/api/tea-entries/${VALID_UUID}`, {
      method: "DELETE",
      headers: { "X-Test-User": "u1" },
    });
    expect(res.status).toBe(404);
  });
});

describe("tea-entries write rate limit (per PAT)", () => {
  it("429s a PAT after 30 POSTs in a minute", async () => {
    mockCreate.mockResolvedValue({
      id: "e1",
      authorId: "u1",
      authorTimezone: "America/Chicago",
      title: null,
      content: "x",
      pin: "1234",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const headers = {
      "Content-Type": "application/json",
      "X-Test-User": "u1",
      "X-Test-Token": "pat-test",
    };
    const body = JSON.stringify({ content: "x", pin: "1234" });

    for (let i = 0; i < 30; i++) {
      const ok = await app.request("/api/tea-entries", { method: "POST", headers, body });
      expect(ok.status).toBe(201);
    }
    const blocked = await app.request("/api/tea-entries", { method: "POST", headers, body });
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("Retry-After")).toBe("60");
  });

  it("JWT requests with no tokenId bypass the limiter", async () => {
    mockCreate.mockResolvedValue({
      id: "e1",
      authorId: "u1",
      authorTimezone: "America/Chicago",
      title: null,
      content: "x",
      pin: "1234",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const headers = { "Content-Type": "application/json", "X-Test-User": "u1" };
    const body = JSON.stringify({ content: "x", pin: "1234" });

    for (let i = 0; i < 40; i++) {
      const res = await app.request("/api/tea-entries", { method: "POST", headers, body });
      expect(res.status).toBe(201);
    }
  });

  it("POST, PATCH, DELETE share the tea-entries-write bucket", async () => {
    mockCreate.mockResolvedValue({
      id: "e1",
      authorId: "u1",
      authorTimezone: "America/Chicago",
      title: null,
      content: "x",
      pin: "1234",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    mockUpdate.mockResolvedValue({
      id: "e1",
      authorId: "u1",
      authorTimezone: "America/Chicago",
      title: "t",
      content: "x",
      pin: "1234",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    mockDelete.mockResolvedValue(true);
    const headers = {
      "Content-Type": "application/json",
      "X-Test-User": "u1",
      "X-Test-Token": "pat-shared",
    };

    // 10 POST + 10 PATCH + 10 DELETE = 30 fills the shared bucket.
    for (let i = 0; i < 10; i++) {
      const r = await app.request("/api/tea-entries", {
        method: "POST",
        headers,
        body: JSON.stringify({ content: "x", pin: "1234" }),
      });
      expect(r.status).toBe(201);
    }
    for (let i = 0; i < 10; i++) {
      const r = await app.request(`/api/tea-entries/${VALID_UUID}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ title: "t" }),
      });
      expect(r.status).toBe(200);
    }
    for (let i = 0; i < 10; i++) {
      const r = await app.request(`/api/tea-entries/${VALID_UUID}`, {
        method: "DELETE",
        headers,
      });
      expect(r.status).toBe(204);
    }
    // 31st request on any of the three is blocked.
    const blocked = await app.request(`/api/tea-entries/${VALID_UUID}`, {
      method: "DELETE",
      headers,
    });
    expect(blocked.status).toBe(429);
  });
});
