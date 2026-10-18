// tests/modules/integrations/calendar-connect-routes.test.ts
import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";

// Passthrough auth so the request reaches the per-route zValidator (the connect
// route mounts requireAuth on "*", which would otherwise 401 before validation).
// The real requireBrowserSession stays; X-Test-Scopes marks the caller as a PAT.
vi.mock("@/modules/auth/middleware", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/modules/auth/middleware")>();
  return {
    ...actual,
    requireAuth: async (c: any, next: any) => {
      const scopes = c.req.header("X-Test-Scopes");
      c.set("userId", "test-user");
      c.set("tokenScopes", scopes === undefined ? null : scopes.split(",").filter(Boolean));
      return next();
    },
  };
});

// The module imports db + schema at load time; stub them so no real connection
// is opened. The bound rejection short-circuits before any db call anyway.
vi.mock("@/db/client", () => ({ db: {} }));
vi.mock("@/db/schema", () => ({ userCalendarConnections: {} }));

import { calendarConnectRoutes } from "@/modules/integrations/calendar-connect";

const app = new Hono().route("/api/integrations/calendar", calendarConnectRoutes);

describe("POST /api/integrations/calendar/connect code bound", () => {
  it("rejects an over-long code with 400 before the Google token exchange", async () => {
    // Guard: if validation let this through, the handler would call fetch.
    const fetchSpy = vi.spyOn(global, "fetch");
    // 9KB string exceeds the 8192-char cap; zod rejects it at validation time.
    const res = await app.request("/api/integrations/calendar/connect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: "x".repeat(9000) }),
    });
    expect(res.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("rejects a missing code with 400", async () => {
    const res = await app.request("/api/integrations/calendar/connect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("accepts an in-bound code (passes validation, reaches the handler)", async () => {
    // Stub the Google token exchange so we only assert validation lets it through.
    const fetchSpy = vi
      .spyOn(global, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }),
      );
    const res = await app.request("/api/integrations/calendar/connect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: "a-normal-auth-code" }),
    });
    // Handler was reached (fetch called); response is the 502 exchange-failure
    // path, NOT the 400 validation path.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(502);
    fetchSpy.mockRestore();
  });
});

// SHAN-593: there is no calendar scope, so any PAT used to be able to swap the
// stored refresh token for another Google account's, or drop the connection.
describe("calendar connect is browser-session only", () => {
  const pat = { "X-Test-Scopes": "reactions:write" };

  it("403s a PAT on POST /connect before the Google code exchange", async () => {
    const fetchSpy = vi.spyOn(global, "fetch");
    const res = await app.request("/api/integrations/calendar/connect", {
      method: "POST",
      headers: { ...pat, "Content-Type": "application/json" },
      body: JSON.stringify({ code: "a-code-from-another-account" }),
    });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/browser session/);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("403s a PAT on DELETE /connect and on GET /status", async () => {
    // db is stubbed as {}, so reaching either handler would throw a 500.
    const del = await app.request("/api/integrations/calendar/connect", { method: "DELETE", headers: pat });
    expect(del.status).toBe(403);
    const status = await app.request("/api/integrations/calendar/status", { headers: pat });
    expect(status.status).toBe(403);
  });
});
