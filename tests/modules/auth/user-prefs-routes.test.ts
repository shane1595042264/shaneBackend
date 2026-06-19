// tests/modules/auth/user-prefs-routes.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

const { mockGet, mockSet, mockClear } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockSet: vi.fn(),
  mockClear: vi.fn(),
}));

vi.mock("@/modules/auth/user-prefs", () => ({
  getUserTimezone: vi.fn().mockResolvedValue("America/Chicago"),
  getUniversalTeaPin: mockGet,
  setUniversalTeaPin: mockSet,
  clearUniversalTeaPin: mockClear,
  DEFAULT_TIMEZONE: "America/Chicago",
}));

// Light-weight middleware mock that mirrors tea-entries/routes.test.ts so
// requireAuth + requireScope behave correctly without needing a real JWT
// verifier or a token row.
vi.mock("@/modules/auth/middleware", () => ({
  optionalAuth: async (c: any, next: any) => {
    c.set("userId", c.req.header("X-Test-User") ?? null);
    const token = c.req.header("X-Test-Token");
    c.set("tokenScopes", token ? (c.req.header("X-Test-Scopes")?.split(",") ?? []) : null);
    c.set("tokenId", token ?? null);
    await next();
  },
  requireAuth: async (c: any, next: any) => {
    const u = c.req.header("X-Test-User");
    if (!u) return c.json({ error: "auth" }, 401);
    c.set("userId", u);
    const token = c.req.header("X-Test-Token");
    c.set("tokenScopes", token ? (c.req.header("X-Test-Scopes")?.split(",") ?? []) : null);
    c.set("tokenId", token ?? null);
    await next();
  },
  requireScope: (scope: string) => async (c: any, next: any) => {
    const scopes = c.get("tokenScopes") as string[] | null;
    // null = JWT (bypass scope check); array = PAT (must include scope).
    if (scopes !== null && !scopes.includes(scope)) {
      return c.json({ error: "missing scope" }, 403);
    }
    await next();
  },
}));

import { userPrefsRoutes } from "@/modules/auth/user-prefs-routes";

beforeEach(() => {
  vi.clearAllMocks();
});

const app = new Hono().route("/api/user-prefs", userPrefsRoutes);

describe("GET /api/user-prefs/tea-universal-pin", () => {
  it("requires auth", async () => {
    const res = await app.request("/api/user-prefs/tea-universal-pin");
    expect(res.status).toBe(401);
  });

  it("returns isSet=false when no pin stored", async () => {
    mockGet.mockResolvedValue(null);
    const res = await app.request("/api/user-prefs/tea-universal-pin", {
      headers: { "X-Test-User": "u1" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ isSet: false });
  });

  it("returns isSet=true and NEVER echoes the actual pin", async () => {
    mockGet.mockResolvedValue("9999");
    const res = await app.request("/api/user-prefs/tea-universal-pin", {
      headers: { "X-Test-User": "u1" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.isSet).toBe(true);
    expect(body).not.toHaveProperty("pin");
    expect(JSON.stringify(body)).not.toContain("9999");
  });
});

describe("PUT /api/user-prefs/tea-universal-pin", () => {
  it("requires auth", async () => {
    const res = await app.request("/api/user-prefs/tea-universal-pin", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pin: "1234" }),
    });
    expect(res.status).toBe(401);
  });

  it("rejects pin that isn't 4 digits", async () => {
    const res = await app.request("/api/user-prefs/tea-universal-pin", {
      method: "PUT",
      headers: { "Content-Type": "application/json", "X-Test-User": "u1" },
      body: JSON.stringify({ pin: "abcd" }),
    });
    expect(res.status).toBe(400);
    expect(mockSet).not.toHaveBeenCalled();
  });

  it("rejects 3-digit pin", async () => {
    const res = await app.request("/api/user-prefs/tea-universal-pin", {
      method: "PUT",
      headers: { "Content-Type": "application/json", "X-Test-User": "u1" },
      body: JSON.stringify({ pin: "123" }),
    });
    expect(res.status).toBe(400);
  });

  it("persists a 4-digit pin and returns isSet=true", async () => {
    mockSet.mockResolvedValue(undefined);
    const res = await app.request("/api/user-prefs/tea-universal-pin", {
      method: "PUT",
      headers: { "Content-Type": "application/json", "X-Test-User": "u1" },
      body: JSON.stringify({ pin: "5678" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ isSet: true });
    expect(mockSet).toHaveBeenCalledWith("u1", "5678");
  });

  it("PAT without entries:write scope is forbidden", async () => {
    const res = await app.request("/api/user-prefs/tea-universal-pin", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "X-Test-User": "u1",
        "X-Test-Token": "pat-x",
        "X-Test-Scopes": "comments:write",
      },
      body: JSON.stringify({ pin: "5678" }),
    });
    expect(res.status).toBe(403);
    expect(mockSet).not.toHaveBeenCalled();
  });

  it("PAT with entries:write scope succeeds", async () => {
    mockSet.mockResolvedValue(undefined);
    const res = await app.request("/api/user-prefs/tea-universal-pin", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "X-Test-User": "u1",
        "X-Test-Token": "pat-x",
        "X-Test-Scopes": "entries:write",
      },
      body: JSON.stringify({ pin: "5678" }),
    });
    expect(res.status).toBe(200);
  });
});

describe("DELETE /api/user-prefs/tea-universal-pin", () => {
  it("requires auth", async () => {
    const res = await app.request("/api/user-prefs/tea-universal-pin", {
      method: "DELETE",
    });
    expect(res.status).toBe(401);
  });

  it("clears the pin and returns isSet=false", async () => {
    mockClear.mockResolvedValue(undefined);
    const res = await app.request("/api/user-prefs/tea-universal-pin", {
      method: "DELETE",
      headers: { "X-Test-User": "u1" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ isSet: false });
    expect(mockClear).toHaveBeenCalledWith("u1");
  });
});
