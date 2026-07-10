import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

const { mockCreate, mockList, mockGet, mockUpdate, mockDelete } = vi.hoisted(() => ({
  mockCreate: vi.fn(),
  mockList: vi.fn(),
  mockGet: vi.fn(),
  mockUpdate: vi.fn(),
  mockDelete: vi.fn(),
}));

vi.mock("@/modules/trips/repo", () => ({
  createTrip: mockCreate,
  listTrips: mockList,
  getTripBySlug: mockGet,
  updateTripBySlug: mockUpdate,
  deleteTripBySlug: mockDelete,
}));

vi.mock("@/modules/auth/middleware", () => ({
  optionalAuth: async (c: any, next: any) => {
    c.set("userId", c.req.header("X-Test-User") ?? null);
    c.set("tokenScopes", null);
    await next();
  },
  requireAuth: async (c: any, next: any) => {
    const u = c.req.header("X-Test-User");
    if (!u) return c.json({ error: "auth" }, 401);
    c.set("userId", u);
    c.set("tokenScopes", null);
    await next();
  },
  requireScope: () => async (_c: any, next: any) => { await next(); },
}));

import { tripsRoutes } from "@/modules/trips/routes";

beforeEach(() => vi.clearAllMocks());

const app = new Hono().route("/api/trips", tripsRoutes);

describe("POST /api/trips (JSON)", () => {
  it("accepts anonymous uploads (no auth) — owner stored as null", async () => {
    mockCreate.mockResolvedValue({
      id: "t1", slug: "anon", title: "Anon", sourceFilename: null, createdAt: new Date(),
    });
    const res = await app.request("/api/trips", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ html: "<title>Anon</title><body></body>" }),
    });
    expect(res.status).toBe(201);
    expect(mockCreate).toHaveBeenCalledWith({
      ownerId: null,
      title: "Anon",
      html: "<title>Anon</title><body></body>",
      sourceFilename: null,
    });
  });

  it("attributes to user when authed", async () => {
    mockCreate.mockResolvedValue({
      id: "t1", slug: "tokyo-trip", title: "Tokyo Trip",
      sourceFilename: null, createdAt: new Date("2026-01-01"),
    });
    const res = await app.request("/api/trips", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Test-User": "u1" },
      body: JSON.stringify({ html: "<title>Tokyo Trip</title><body></body>" }),
    });
    expect(res.status).toBe(201);
    expect(mockCreate).toHaveBeenCalledWith({
      ownerId: "u1",
      title: "Tokyo Trip",
      html: "<title>Tokyo Trip</title><body></body>",
      sourceFilename: null,
    });
  });

  it("prefers explicit body title over extracted <title>", async () => {
    mockCreate.mockResolvedValue({
      id: "t1", slug: "manual", title: "Manual Override",
      sourceFilename: null, createdAt: new Date(),
    });
    await app.request("/api/trips", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Test-User": "u1" },
      body: JSON.stringify({ html: "<title>From HTML</title>", title: "Manual Override" }),
    });
    expect(mockCreate.mock.calls[0][0].title).toBe("Manual Override");
  });

  it("falls back to null title when no <title>, no <h1>, no override", async () => {
    mockCreate.mockResolvedValue({
      id: "t1", slug: "abcdefgh", title: null,
      sourceFilename: null, createdAt: new Date(),
    });
    await app.request("/api/trips", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Test-User": "u1" },
      body: JSON.stringify({ html: "<p>just a paragraph</p>" }),
    });
    expect(mockCreate.mock.calls[0][0].title).toBeNull();
  });

  it("rejects empty html", async () => {
    const res = await app.request("/api/trips", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Test-User": "u1" },
      body: JSON.stringify({ html: "" }),
    });
    expect(res.status).toBe(400);
    expect(mockCreate).not.toHaveBeenCalled();
  });
});

describe("POST /api/trips (multipart)", () => {
  it("accepts a multipart file upload and extracts title", async () => {
    mockCreate.mockResolvedValue({
      id: "t1", slug: "tokyo-trip", title: "Tokyo Trip",
      sourceFilename: "itinerary.html", createdAt: new Date(),
    });
    const form = new FormData();
    form.append("file", new File(["<title>Tokyo Trip</title>"], "itinerary.html", { type: "text/html" }));
    const res = await app.request("/api/trips", {
      method: "POST",
      headers: { "X-Test-User": "u1" },
      body: form,
    });
    expect(res.status).toBe(201);
    expect(mockCreate.mock.calls[0][0]).toMatchObject({
      ownerId: "u1",
      title: "Tokyo Trip",
      sourceFilename: "itinerary.html",
    });
  });

  it("falls back to a cleaned-up filename when html has no title at all", async () => {
    mockCreate.mockResolvedValue({
      id: "t1", slug: "x", title: "my italy trip",
      sourceFilename: "my_italy_trip.html", createdAt: new Date(),
    });
    const form = new FormData();
    form.append("file", new File(["<p>no title here</p>"], "my_italy_trip.html"));
    await app.request("/api/trips", { method: "POST", headers: { "X-Test-User": "u1" }, body: form });
    expect(mockCreate.mock.calls[0][0].title).toBe("my italy trip");
  });

  it("returns 400 when 'file' is missing", async () => {
    const form = new FormData();
    form.append("notfile", "oops");
    const res = await app.request("/api/trips", {
      method: "POST",
      headers: { "X-Test-User": "u1" },
      body: form,
    });
    expect(res.status).toBe(400);
  });
});

describe("GET /api/trips", () => {
  it("lists trips (anonymous OK); no params → full list, nextCursor null", async () => {
    mockList.mockResolvedValue([{ id: "t1", slug: "tokyo", title: "Tokyo" }]);
    const res = await app.request("/api/trips");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.trips).toHaveLength(1);
    expect(body.nextCursor).toBeNull();
    // Legacy behavior preserved: called with no bounds.
    expect(mockList).toHaveBeenCalledWith({ limit: undefined, cursor: undefined });
  });

  it("passes limit + cursor through to the repo", async () => {
    mockList.mockResolvedValue([]);
    await app.request("/api/trips?limit=10&cursor=2026-01-01T00:00:00.000Z");
    expect(mockList).toHaveBeenCalledWith({ limit: 10, cursor: "2026-01-01T00:00:00.000Z" });
  });

  it("rejects a malformed (non-ISO) cursor with 400 instead of silently returning page 1", async () => {
    mockList.mockResolvedValue([]);
    const res = await app.request("/api/trips?cursor=not-a-date");
    expect(res.status).toBe(400);
    expect(mockList).not.toHaveBeenCalled();
  });

  it("returns nextCursor = last createdAt when a full page comes back", async () => {
    const last = new Date("2026-02-01T12:00:00.000Z");
    mockList.mockResolvedValue([
      { id: "t1", slug: "a", title: "A", createdAt: new Date("2026-03-01T00:00:00.000Z") },
      { id: "t2", slug: "b", title: "B", createdAt: last },
    ]);
    const res = await app.request("/api/trips?limit=2");
    const body = await res.json();
    expect(body.nextCursor).toBe(last.toISOString());
  });

  it("returns nextCursor null when fewer than limit rows come back (last page)", async () => {
    mockList.mockResolvedValue([
      { id: "t1", slug: "a", title: "A", createdAt: new Date("2026-03-01T00:00:00.000Z") },
    ]);
    const res = await app.request("/api/trips?limit=10");
    const body = await res.json();
    expect(body.nextCursor).toBeNull();
  });

  it("rejects an out-of-range limit at the validator (0)", async () => {
    const res = await app.request("/api/trips?limit=0");
    expect(res.status).toBe(400);
    expect(mockList).not.toHaveBeenCalled();
  });

  it("rejects a non-numeric limit at the validator", async () => {
    const res = await app.request("/api/trips?limit=abc");
    expect(res.status).toBe(400);
    expect(mockList).not.toHaveBeenCalled();
  });
});

describe("GET /api/trips/:slug", () => {
  it("returns the trip when found", async () => {
    mockGet.mockResolvedValue({ slug: "tokyo", title: "Tokyo", html: "<p>hi</p>" });
    const res = await app.request("/api/trips/tokyo");
    expect(res.status).toBe(200);
    expect((await res.json()).trip.title).toBe("Tokyo");
  });

  it("returns 404 when missing", async () => {
    mockGet.mockResolvedValue(null);
    const res = await app.request("/api/trips/nope");
    expect(res.status).toBe(404);
  });

  it("rejects malformed slugs at the validator", async () => {
    const res = await app.request("/api/trips/UPPERCASE");
    expect(res.status).toBe(400);
    expect(mockGet).not.toHaveBeenCalled();
  });
});

// Helper: shape returned by getTripBySlug. Tests below only care about
// ownerId and slug for the ownership branch, so the rest is filler.
const tripRow = (ownerId: string | null) => ({
  id: "t1",
  slug: "tokyo",
  title: "Tokyo",
  html: "<p>hi</p>",
  sourceFilename: null,
  ownerId,
  ownerName: null,
  createdAt: new Date(),
  updatedAt: new Date(),
});

describe("PATCH /api/trips/:slug", () => {
  it("anonymous trip — anyone may patch (free-for-all preserved)", async () => {
    mockGet.mockResolvedValue(tripRow(null));
    mockUpdate.mockResolvedValue({
      id: "t1", slug: "tokyo", title: "Updated", sourceFilename: null, updatedAt: new Date(),
    });
    const res = await app.request("/api/trips/tokyo", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Updated" }),
    });
    expect(res.status).toBe(200);
  });

  it("authed trip — anonymous caller gets 403", async () => {
    mockGet.mockResolvedValue(tripRow("u1"));
    const res = await app.request("/api/trips/tokyo", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Updated" }),
    });
    expect(res.status).toBe(403);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("authed trip — authed-but-not-owner caller gets 403", async () => {
    mockGet.mockResolvedValue(tripRow("u1"));
    const res = await app.request("/api/trips/tokyo", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "X-Test-User": "u2" },
      body: JSON.stringify({ title: "Updated" }),
    });
    expect(res.status).toBe(403);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("authed trip — owner may patch", async () => {
    mockGet.mockResolvedValue(tripRow("u1"));
    mockUpdate.mockResolvedValue({
      id: "t1", slug: "tokyo", title: "Updated", sourceFilename: null, updatedAt: new Date(),
    });
    const res = await app.request("/api/trips/tokyo", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "X-Test-User": "u1" },
      body: JSON.stringify({ title: "Updated" }),
    });
    expect(res.status).toBe(200);
  });

  it("updates html + re-extracts title when no explicit title given", async () => {
    mockGet.mockResolvedValue(tripRow("u1"));
    mockUpdate.mockResolvedValue({
      id: "t1", slug: "tokyo", title: "New Title", sourceFilename: null, updatedAt: new Date(),
    });
    const res = await app.request("/api/trips/tokyo", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "X-Test-User": "u1" },
      body: JSON.stringify({ html: "<title>New Title</title><body>new</body>" }),
    });
    expect(res.status).toBe(200);
    expect(mockUpdate).toHaveBeenCalledWith("tokyo", {
      html: "<title>New Title</title><body>new</body>",
      title: "New Title",
      sourceFilename: undefined,
    });
  });

  it("explicit title in body overrides extraction", async () => {
    mockGet.mockResolvedValue(tripRow("u1"));
    mockUpdate.mockResolvedValue({
      id: "t1", slug: "tokyo", title: "Override", sourceFilename: null, updatedAt: new Date(),
    });
    await app.request("/api/trips/tokyo", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "X-Test-User": "u1" },
      body: JSON.stringify({ html: "<title>From HTML</title>", title: "Override" }),
    });
    expect(mockUpdate.mock.calls[0][1].title).toBe("Override");
  });

  it("title-only update (no html) leaves title-passthrough explicit", async () => {
    mockGet.mockResolvedValue(tripRow("u1"));
    mockUpdate.mockResolvedValue({
      id: "t1", slug: "tokyo", title: "Just A Rename", sourceFilename: null, updatedAt: new Date(),
    });
    await app.request("/api/trips/tokyo", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "X-Test-User": "u1" },
      body: JSON.stringify({ title: "Just A Rename" }),
    });
    expect(mockUpdate.mock.calls[0][1]).toEqual({
      html: undefined,
      title: "Just A Rename",
      sourceFilename: undefined,
    });
  });

  it("400 when the body has nothing to update", async () => {
    mockGet.mockResolvedValue(tripRow("u1"));
    const res = await app.request("/api/trips/tokyo", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "X-Test-User": "u1" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("404 when slug missing", async () => {
    mockGet.mockResolvedValue(null);
    const res = await app.request("/api/trips/tokyo", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "X-Test-User": "u1" },
      body: JSON.stringify({ title: "x" }),
    });
    expect(res.status).toBe(404);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("multipart upload replaces html + sourceFilename", async () => {
    mockGet.mockResolvedValue(tripRow("u1"));
    mockUpdate.mockResolvedValue({
      id: "t1", slug: "tokyo", title: "Tokyo v2", sourceFilename: "tokyo_v2.html", updatedAt: new Date(),
    });
    const form = new FormData();
    form.append("file", new File(["<title>Tokyo v2</title>"], "tokyo_v2.html"));
    await app.request("/api/trips/tokyo", {
      method: "PATCH",
      headers: { "X-Test-User": "u1" },
      body: form,
    });
    expect(mockUpdate.mock.calls[0][1]).toMatchObject({
      title: "Tokyo v2",
      sourceFilename: "tokyo_v2.html",
    });
  });
});

describe("DELETE /api/trips/:slug", () => {
  it("anonymous trip — anyone may delete (free-for-all preserved)", async () => {
    mockGet.mockResolvedValue(tripRow(null));
    mockDelete.mockResolvedValue(true);
    const res = await app.request("/api/trips/tokyo", { method: "DELETE" });
    expect(res.status).toBe(204);
    expect(mockDelete).toHaveBeenCalledWith("tokyo");
  });

  it("authed trip — anonymous caller gets 403", async () => {
    mockGet.mockResolvedValue(tripRow("u1"));
    const res = await app.request("/api/trips/tokyo", { method: "DELETE" });
    expect(res.status).toBe(403);
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it("authed trip — authed-but-not-owner caller gets 403", async () => {
    mockGet.mockResolvedValue(tripRow("u1"));
    const res = await app.request("/api/trips/tokyo", {
      method: "DELETE",
      headers: { "X-Test-User": "u2" },
    });
    expect(res.status).toBe(403);
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it("authed trip — owner may delete", async () => {
    mockGet.mockResolvedValue(tripRow("u1"));
    mockDelete.mockResolvedValue(true);
    const res = await app.request("/api/trips/tokyo", {
      method: "DELETE",
      headers: { "X-Test-User": "u1" },
    });
    expect(res.status).toBe(204);
    expect(mockDelete).toHaveBeenCalledWith("tokyo");
  });

  it("404 when slug missing", async () => {
    mockGet.mockResolvedValue(null);
    const res = await app.request("/api/trips/tokyo", { method: "DELETE" });
    expect(res.status).toBe(404);
    expect(mockDelete).not.toHaveBeenCalled();
  });
});
