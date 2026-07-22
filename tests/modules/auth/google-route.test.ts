// tests/modules/auth/google-route.test.ts
import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";

vi.mock("@/modules/auth/config", () => ({
  JWT_SECRET: new TextEncoder().encode("test-secret-min-32-bytes-long-xxxx"),
}));

import { authRoutes } from "@/modules/auth/routes";

const app = new Hono().route("/api/auth", authRoutes);

describe("POST /api/auth/google credential bound", () => {
  it("rejects an over-long credential with 400 before verifying it", async () => {
    // 9KB string exceeds the 8192-char cap; zod rejects it at validation time,
    // so jwtVerify (and its remote JWKS fetch) is never reached.
    const res = await app.request("/api/auth/google", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ credential: "x".repeat(9000) }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects a missing credential with 400", async () => {
    const res = await app.request("/api/auth/google", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});
