// tests/modules/auth/tokens-routes.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

const { mockMint, mockList, mockRevoke } = vi.hoisted(() => ({
  mockMint: vi.fn(),
  mockList: vi.fn(),
  mockRevoke: vi.fn(),
}));

vi.mock("@/modules/auth/tokens", () => ({
  mintToken: mockMint,
  listTokens: mockList,
  revokeToken: mockRevoke,
  TOKEN_PREFIX: "pat_",
  lookupActiveToken: vi.fn(),
}));

vi.mock("@/modules/auth/config", () => ({
  JWT_SECRET: new TextEncoder().encode("test-secret-min-32-bytes-long-xxxx"),
}));

import { authRoutes } from "@/modules/auth/routes";
import { SignJWT } from "jose";

const SECRET = new TextEncoder().encode("test-secret-min-32-bytes-long-xxxx");

async function jwt(userId: string) {
  return new SignJWT({ userId, email: "x@y" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(SECRET);
}

beforeEach(() => vi.clearAllMocks());

const app = new Hono().route("/api/auth", authRoutes);

describe("POST /api/auth/tokens", () => {
  it("mints and returns the raw token once", async () => {
    mockMint.mockResolvedValue({ raw: "pat_abcdef", id: "tok-1" });
    const tok = await jwt("user-1");
    const res = await app.request("/api/auth/tokens", {
      method: "POST",
      headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "convey", scopes: ["entries:write"] }),
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ id: "tok-1", token: "pat_abcdef" });
    expect(mockMint).toHaveBeenCalledWith("user-1", "convey", ["entries:write"]);
  });

  it("returns 401 without auth", async () => {
    const res = await app.request("/api/auth/tokens", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "x", scopes: [] }),
    });
    expect(res.status).toBe(401);
  });

  it("rejects scopes outside the allowed set with 400", async () => {
    const tok = await jwt("user-1");
    const res = await app.request("/api/auth/tokens", {
      method: "POST",
      headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "x", scopes: ["admin:everything"] }),
    });
    expect(res.status).toBe(400);
  });

  it("defaults scopes to [] when not provided", async () => {
    mockMint.mockResolvedValue({ raw: "pat_xyz", id: "tok-2" });
    const tok = await jwt("user-1");
    const res = await app.request("/api/auth/tokens", {
      method: "POST",
      headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "noscopes" }),
    });
    expect(res.status).toBe(201);
    expect(mockMint).toHaveBeenCalledWith("user-1", "noscopes", []);
  });
});

describe("GET /api/auth/tokens", () => {
  it("lists user's tokens without raw values or hashes", async () => {
    mockList.mockResolvedValue([
      { id: "tok-1", name: "convey", scopes: ["entries:write"], lastUsedAt: null, revokedAt: null, createdAt: new Date() },
    ]);
    const tok = await jwt("user-1");
    const res = await app.request("/api/auth/tokens", {
      headers: { Authorization: `Bearer ${tok}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tokens).toHaveLength(1);
    expect(body.tokens[0]).not.toHaveProperty("token");
    expect(body.tokens[0]).not.toHaveProperty("tokenHash");
  });

  it("returns 401 without auth", async () => {
    const res = await app.request("/api/auth/tokens");
    expect(res.status).toBe(401);
  });
});

describe("DELETE /api/auth/tokens/:id", () => {
  it("revokes the token", async () => {
    mockRevoke.mockResolvedValue(true);
    const tok = await jwt("user-1");
    const res = await app.request("/api/auth/tokens/tok-1", {
      method: "DELETE",
      headers: { Authorization: `Bearer ${tok}` },
    });
    expect(res.status).toBe(204);
    expect(mockRevoke).toHaveBeenCalledWith("user-1", "tok-1");
  });

  it("returns 404 if no matching token", async () => {
    mockRevoke.mockResolvedValue(false);
    const tok = await jwt("user-1");
    const res = await app.request("/api/auth/tokens/missing", {
      method: "DELETE",
      headers: { Authorization: `Bearer ${tok}` },
    });
    expect(res.status).toBe(404);
  });
});
