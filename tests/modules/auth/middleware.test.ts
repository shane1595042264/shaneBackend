// tests/modules/auth/middleware.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";

const { mockLookupActiveToken, mockSelect } = vi.hoisted(() => ({
  mockLookupActiveToken: vi.fn(),
  mockSelect: vi.fn(),
}));

vi.mock("@/modules/auth/tokens", () => ({
  lookupActiveToken: mockLookupActiveToken,
  TOKEN_PREFIX: "pat_",
}));

vi.mock("@/modules/auth/config", () => ({
  JWT_SECRET: new TextEncoder().encode("test-secret-min-32-bytes-long-xxxx"),
}));

vi.mock("@/db/client", () => ({
  db: { select: mockSelect },
}));

vi.mock("@/db/schema", () => ({
  users: { id: "users.id", email: "users.email" },
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((c: unknown, v: unknown) => ({ c, v })),
}));

import { jwtVerify, SignJWT } from "jose";
import { optionalAuth, requireAuth, requireScope, requireAdmin } from "@/modules/auth/middleware";

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

describe("requireAdmin", () => {
  function chain(rows: { email: string }[]) {
    const c: Record<string, unknown> = {};
    const t = Promise.resolve(rows);
    for (const m of ["from", "where"]) c[m] = vi.fn(() => c);
    Object.assign(c, { then: (r: any, j: any) => t.then(r, j) });
    return c;
  }

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns 401 when there is no auth", async () => {
    vi.stubEnv("ADMIN_EMAILS", "shane@example.com");
    const app = new Hono().use(requireAuth).use(requireAdmin()).get("/", (c) => c.text("ok"));
    const res = await app.request("/");
    expect(res.status).toBe(401);
  });

  it("rejects PAT requests outright, even if the user behind it is an admin", async () => {
    vi.stubEnv("ADMIN_EMAILS", "shane@example.com");
    mockLookupActiveToken.mockResolvedValue({ userId: "user-admin", scopes: [], tokenId: "tok-1" });
    const app = new Hono().use(requireAuth).use(requireAdmin()).get("/", (c) => c.text("ok"));
    const res = await app.request("/", { headers: { Authorization: "Bearer pat_abc" } });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/browser session/i);
  });

  it("returns 403 when ADMIN_EMAILS is unset (safe default)", async () => {
    vi.stubEnv("ADMIN_EMAILS", "");
    const tok = await makeJwt("user-shane");
    const app = new Hono().use(requireAuth).use(requireAdmin()).get("/", (c) => c.text("ok"));
    const res = await app.request("/", { headers: { Authorization: `Bearer ${tok}` } });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/not configured/i);
  });

  it("returns 403 when the JWT user's email is not in the whitelist", async () => {
    vi.stubEnv("ADMIN_EMAILS", "shane@example.com");
    mockSelect.mockReturnValue(chain([{ email: "stranger@example.com" }]));
    const tok = await makeJwt("user-stranger");
    const app = new Hono().use(requireAuth).use(requireAdmin()).get("/", (c) => c.text("ok"));
    const res = await app.request("/", { headers: { Authorization: `Bearer ${tok}` } });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/admin/i);
  });

  it("returns 403 when the user row is missing", async () => {
    vi.stubEnv("ADMIN_EMAILS", "shane@example.com");
    mockSelect.mockReturnValue(chain([]));
    const tok = await makeJwt("user-ghost");
    const app = new Hono().use(requireAuth).use(requireAdmin()).get("/", (c) => c.text("ok"));
    const res = await app.request("/", { headers: { Authorization: `Bearer ${tok}` } });
    expect(res.status).toBe(403);
  });

  it("passes through when the JWT user's email is in the whitelist (case-insensitive)", async () => {
    vi.stubEnv("ADMIN_EMAILS", "Shane@Example.com, other@x.com");
    mockSelect.mockReturnValue(chain([{ email: "shane@example.com" }]));
    const tok = await makeJwt("user-shane");
    const app = new Hono().use(requireAuth).use(requireAdmin()).get("/", (c) => c.text("ok"));
    const res = await app.request("/", { headers: { Authorization: `Bearer ${tok}` } });
    expect(res.status).toBe(200);
  });

  it("ignores whitespace and empty entries in ADMIN_EMAILS", async () => {
    vi.stubEnv("ADMIN_EMAILS", ",, shane@example.com  , ");
    mockSelect.mockReturnValue(chain([{ email: "shane@example.com" }]));
    const tok = await makeJwt("user-shane");
    const app = new Hono().use(requireAuth).use(requireAdmin()).get("/", (c) => c.text("ok"));
    const res = await app.request("/", { headers: { Authorization: `Bearer ${tok}` } });
    expect(res.status).toBe(200);
  });
});
