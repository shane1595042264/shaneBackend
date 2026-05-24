import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

const { mockCreate, mockList, mockGet, mockDelete } = vi.hoisted(() => ({
  mockCreate: vi.fn(),
  mockList: vi.fn(),
  mockGet: vi.fn(),
  mockDelete: vi.fn(),
}));

vi.mock("@/modules/trips/repo", () => ({
  createTrip: mockCreate,
  listTrips: mockList,
  getTripBySlug: mockGet,
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
  it("rejects unauthenticated requests", async () => {
    const res = await app.request("/api/trips", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ html: "<p>hi</p>" }),
    });
    expect(res.status).toBe(401);
  });

  it("creates a trip from JSON body, extracts title from <title>", async () => {
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
  it("lists trips (anonymous OK)", async () => {
    mockList.mockResolvedValue([{ id: "t1", slug: "tokyo", title: "Tokyo" }]);
    const res = await app.request("/api/trips");
    expect(res.status).toBe(200);
    expect((await res.json()).trips).toHaveLength(1);
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

describe("DELETE /api/trips/:slug", () => {
  it("204 on successful delete", async () => {
    mockDelete.mockResolvedValue(true);
    const res = await app.request("/api/trips/tokyo", {
      method: "DELETE",
      headers: { "X-Test-User": "u1" },
    });
    expect(res.status).toBe(204);
    expect(mockDelete).toHaveBeenCalledWith("tokyo", "u1");
  });

  it("404 when caller isn't owner or slug missing", async () => {
    mockDelete.mockResolvedValue(false);
    const res = await app.request("/api/trips/tokyo", {
      method: "DELETE",
      headers: { "X-Test-User": "u1" },
    });
    expect(res.status).toBe(404);
  });
});
