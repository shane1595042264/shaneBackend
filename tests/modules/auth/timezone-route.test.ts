// tests/modules/auth/timezone-route.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

const { mockUpdate } = vi.hoisted(() => ({ mockUpdate: vi.fn() }));

// Drizzle's update() returns a chainable builder. We only care about the
// final .returning(...) result, so each link returns the next builder.
vi.mock("@/db/client", () => ({
  db: {
    select: vi.fn(),
    update: () => ({
      set: () => ({
        where: () => ({
          returning: () => mockUpdate(),
        }),
      }),
    }),
  },
}));

vi.mock("@/modules/auth/tokens", () => ({
  mintToken: vi.fn(),
  listTokens: vi.fn(),
  revokeToken: vi.fn(),
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

describe("PATCH /api/auth/me/timezone", () => {
  it("rejects unauthenticated requests", async () => {
    const res = await app.request("/api/auth/me/timezone", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ timezone: "America/New_York" }),
    });
    expect(res.status).toBe(401);
  });

  it("accepts a valid IANA timezone and persists it", async () => {
    mockUpdate.mockResolvedValue([{ timezone: "America/New_York" }]);
    const tok = await jwt("u-1");
    const res = await app.request("/api/auth/me/timezone", {
      method: "PATCH",
      headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
      body: JSON.stringify({ timezone: "America/New_York" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ timezone: "America/New_York" });
    expect(mockUpdate).toHaveBeenCalledOnce();
  });

  it("rejects an unknown IANA timezone with 400", async () => {
    const tok = await jwt("u-1");
    const res = await app.request("/api/auth/me/timezone", {
      method: "PATCH",
      headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
      body: JSON.stringify({ timezone: "Not/A_Real_Zone" }),
    });
    expect(res.status).toBe(400);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("rejects malformed input via zod (special chars)", async () => {
    const tok = await jwt("u-1");
    const res = await app.request("/api/auth/me/timezone", {
      method: "PATCH",
      headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
      body: JSON.stringify({ timezone: "; DROP TABLE users; --" }),
    });
    expect(res.status).toBe(400);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("returns 404 if the user row vanished mid-flight", async () => {
    mockUpdate.mockResolvedValue([]);
    const tok = await jwt("u-1");
    const res = await app.request("/api/auth/me/timezone", {
      method: "PATCH",
      headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
      body: JSON.stringify({ timezone: "Europe/Berlin" }),
    });
    expect(res.status).toBe(404);
  });
});
