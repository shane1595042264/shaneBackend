// tests/modules/integrations/calendar-connect-routes.test.ts
import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";

// Passthrough auth so the request reaches the per-route zValidator (the connect
// route mounts requireAuth on "*", which would otherwise 401 before validation).
vi.mock("@/modules/auth/middleware", () => ({
  requireAuth: async (c: any, next: any) => {
    c.set("userId", "test-user");
    return next();
  },
}));

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
