import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { SignJWT } from "jose";

const { mockGetOrCreate, mockEnsureUser, mockSign, mockLookupActiveToken } = vi.hoisted(() => ({
  mockGetOrCreate: vi.fn(),
  mockEnsureUser: vi.fn(),
  mockSign: vi.fn(),
  mockLookupActiveToken: vi.fn(),
}));

vi.mock("@/modules/blitz/accounts-repo", () => ({ getOrCreateSyncAccount: mockGetOrCreate }));
vi.mock("@/modules/blitz/supersync-db", () => ({ ensureSupersyncUser: mockEnsureUser }));
vi.mock("@/modules/blitz/token", () => ({ signSupersyncToken: mockSign }));
vi.mock("@/modules/auth/tokens", () => ({
  TOKEN_PREFIX: "pat_",
  lookupActiveToken: mockLookupActiveToken,
}));
vi.mock("@/modules/auth/config", () => ({
  JWT_SECRET: new TextEncoder().encode("test-secret-min-32-bytes-long-xxxx"),
}));

import { blitzRoutes } from "@/modules/blitz/routes";

const SECRET = new TextEncoder().encode("test-secret-min-32-bytes-long-xxxx");
async function jwt(userId: string) {
  return new SignJWT({ userId, email: "x@y" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(SECRET);
}

const app = new Hono().route("/api/blitz", blitzRoutes);

beforeEach(() => {
  vi.clearAllMocks();
  process.env.SUPERSYNC_PUBLIC_URL = "https://sync.example.test";
});

describe("POST /api/blitz/sync-session", () => {
  it("returns baseUrl, token, and the user's encryption key for a browser session", async () => {
    mockGetOrCreate.mockResolvedValue({
      supersyncUserId: 5,
      encryptKey: "k".repeat(43),
      email: "shane@example.com",
    });
    mockEnsureUser.mockResolvedValue({ id: 5, tokenVersion: 3 });
    mockSign.mockResolvedValue({ token: "eyJ.sync.token", expiresAt: "2027-09-02T00:00:00.000Z" });

    const res = await app.request("/api/blitz/sync-session", {
      method: "POST",
      headers: { Authorization: `Bearer ${await jwt("user-1")}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      baseUrl: "https://sync.example.test",
      accessToken: "eyJ.sync.token",
      encryptKey: "k".repeat(43),
      email: "shane@example.com",
      expiresAt: "2027-09-02T00:00:00.000Z",
    });
    expect(mockGetOrCreate).toHaveBeenCalledWith("user-1");
    expect(mockSign).toHaveBeenCalledWith({ userId: 5, email: "shane@example.com", tokenVersion: 3 });
  });

  it("returns 401 without auth", async () => {
    const res = await app.request("/api/blitz/sync-session", { method: "POST" });
    expect(res.status).toBe(401);
    expect(mockGetOrCreate).not.toHaveBeenCalled();
  });

  it("refuses PATs with 403", async () => {
    mockLookupActiveToken.mockResolvedValue({ id: "tok-1", userId: "user-1", scopes: ["entries:write"] });
    const res = await app.request("/api/blitz/sync-session", {
      method: "POST",
      headers: { Authorization: "Bearer pat_abc" },
    });
    expect(res.status).toBe(403);
    expect(mockGetOrCreate).not.toHaveBeenCalled();
  });
});
