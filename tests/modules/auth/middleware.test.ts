// tests/modules/auth/middleware.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

const { mockLookupActiveToken } = vi.hoisted(() => ({
  mockLookupActiveToken: vi.fn(),
}));

vi.mock("@/modules/auth/tokens", () => ({
  lookupActiveToken: mockLookupActiveToken,
  TOKEN_PREFIX: "pat_",
}));

vi.mock("@/modules/auth/config", () => ({
  JWT_SECRET: new TextEncoder().encode("test-secret-min-32-bytes-long-xxxx"),
}));

import { jwtVerify, SignJWT } from "jose";
import { optionalAuth, requireAuth, requireScope } from "@/modules/auth/middleware";

const SECRET = new TextEncoder().encode("test-secret-min-32-bytes-long-xxxx");

beforeEach(() => vi.clearAllMocks());

async function makeJwt(userId: string) {
  return new SignJWT({ userId, email: "x@y" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(SECRET);
}

describe("optionalAuth", () => {
  it("sets userId from a valid JWT", async () => {
    const app = new Hono().use(optionalAuth).get("/", (c) => c.json({ userId: c.get("userId"), scopes: c.get("tokenScopes") }));
    const tok = await makeJwt("user-1");
    const res = await app.request("/", { headers: { Authorization: `Bearer ${tok}` } });
    expect(await res.json()).toEqual({ userId: "user-1", scopes: null });
  });

  it("sets userId and scopes from a valid PAT", async () => {
    mockLookupActiveToken.mockResolvedValue({ userId: "user-2", scopes: ["entries:write"] });
    const app = new Hono().use(optionalAuth).get("/", (c) => c.json({ userId: c.get("userId"), scopes: c.get("tokenScopes") }));
    const res = await app.request("/", { headers: { Authorization: "Bearer pat_abc" } });
    expect(await res.json()).toEqual({ userId: "user-2", scopes: ["entries:write"] });
  });

  it("leaves userId null with no auth header", async () => {
    const app = new Hono().use(optionalAuth).get("/", (c) => c.json({ userId: c.get("userId") }));
    const res = await app.request("/");
    expect(await res.json()).toEqual({ userId: null });
  });

  it("leaves userId null on an invalid JWT", async () => {
    const app = new Hono().use(optionalAuth).get("/", (c) => c.json({ userId: c.get("userId") }));
    const res = await app.request("/", { headers: { Authorization: "Bearer notajwt" } });
    expect(await res.json()).toEqual({ userId: null });
  });

  it("leaves userId null on a revoked/missing PAT", async () => {
    mockLookupActiveToken.mockResolvedValue(null);
    const app = new Hono().use(optionalAuth).get("/", (c) => c.json({ userId: c.get("userId") }));
    const res = await app.request("/", { headers: { Authorization: "Bearer pat_abc" } });
    expect(await res.json()).toEqual({ userId: null });
  });
});

describe("requireAuth", () => {
  it("returns 401 with no token", async () => {
    const app = new Hono().use(requireAuth).get("/", (c) => c.text("ok"));
    const res = await app.request("/");
    expect(res.status).toBe(401);
  });

  it("passes through with a valid PAT", async () => {
    mockLookupActiveToken.mockResolvedValue({ userId: "user-3", scopes: [] });
    const app = new Hono().use(requireAuth).get("/", (c) => c.text("ok"));
    const res = await app.request("/", { headers: { Authorization: "Bearer pat_abc" } });
    expect(res.status).toBe(200);
  });

  it("passes through with a valid JWT", async () => {
    const tok = await makeJwt("user-4");
    const app = new Hono().use(requireAuth).get("/", (c) => c.text("ok"));
    const res = await app.request("/", { headers: { Authorization: `Bearer ${tok}` } });
    expect(res.status).toBe(200);
  });
});

describe("requireScope", () => {
  it("blocks PAT without the required scope", async () => {
    mockLookupActiveToken.mockResolvedValue({ userId: "user-5", scopes: ["comments:write"] });
    const app = new Hono().use(requireAuth).use(requireScope("entries:write")).get("/", (c) => c.text("ok"));
    const res = await app.request("/", { headers: { Authorization: "Bearer pat_abc" } });
    expect(res.status).toBe(403);
  });

  it("allows PAT with the required scope", async () => {
    mockLookupActiveToken.mockResolvedValue({ userId: "user-6", scopes: ["entries:write"] });
    const app = new Hono().use(requireAuth).use(requireScope("entries:write")).get("/", (c) => c.text("ok"));
    const res = await app.request("/", { headers: { Authorization: "Bearer pat_abc" } });
    expect(res.status).toBe(200);
  });

  it("bypasses scope check for a JWT session (scopes is null)", async () => {
    const tok = await makeJwt("user-7");
    const app = new Hono().use(requireAuth).use(requireScope("entries:write")).get("/", (c) => c.text("ok"));
    const res = await app.request("/", { headers: { Authorization: `Bearer ${tok}` } });
    expect(res.status).toBe(200);
  });
});
