// SHAN-351: the admin/debug endpoints in src/app.ts must not leak raw
// err.message in their 500 response bodies. The real error is logged
// server-side; the client only ever sees a safe, generic message. Mirrors the
// SHAN-346 harness (tests/modules/rng-capitalist/evaluate-error-sanitization).
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockGetPool, mockIngestActivities, mockGenerateText } = vi.hoisted(() => ({
  mockGetPool: vi.fn(),
  mockIngestActivities: vi.fn(),
  mockGenerateText: vi.fn(),
}));

// Full mock of the db client so importing the whole app never touches a real DB.
vi.mock("@/db/client", () => ({
  getPool: (...args: any[]) => mockGetPool(...args),
  getDb: () => ({}),
  pool: { get: (...args: any[]) => mockGetPool(...args) },
  db: {},
}));

vi.mock("@/cron/ingest", () => ({
  ingestActivities: (...args: any[]) => mockIngestActivities(...args),
}));

vi.mock("@/modules/shared/llm", () => ({
  generateText: (...args: any[]) => mockGenerateText(...args),
}));

import app from "@/app";

const ADMIN_TOKEN = "test-admin-token-shan351";

const adminHeaders = {
  "Content-Type": "application/json",
  Authorization: `Bearer ${ADMIN_TOKEN}`,
};

beforeEach(() => {
  vi.clearAllMocks();
  process.env.ADMIN_TOKEN = ADMIN_TOKEN;
});

describe("SHAN-351: admin/debug endpoint error sanitization", () => {
  it("POST /api/admin/migrate-vocabulary returns a safe 500, no raw DB internals", async () => {
    mockGetPool.mockReturnValue({
      query: vi.fn().mockRejectedValue(
        new Error("connection to server at internal.db.host:5432 failed: password=super-secret-pw")
      ),
    });

    const res = await app.request("/api/admin/migrate-vocabulary", {
      method: "POST",
      headers: adminHeaders,
    });

    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.error).toBe("Migration failed");
    expect(json.error).not.toContain("internal.db.host");
    expect(json.error).not.toContain("super-secret-pw");
    expect(json.error).not.toContain("password");
  });

  it("GET /api/admin/ingest/:date returns a safe 500, no raw internals", async () => {
    mockIngestActivities.mockRejectedValue(
      new Error("getaddrinfo ENOTFOUND strava-secret.internal token=leak-me")
    );

    const res = await app.request("/api/admin/ingest/2026-07-04", {
      method: "GET",
      headers: adminHeaders,
    });

    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.error).toBe("Ingestion failed");
    expect(json.error).not.toContain("ENOTFOUND");
    expect(json.error).not.toContain("strava-secret.internal");
    expect(json.error).not.toContain("leak-me");
  });

  it("GET /api/admin/test-llm returns a safe 500, no leaked provider API keys", async () => {
    mockGenerateText.mockRejectedValue(
      new Error("All LLM providers failed. Anthropic: 401 invalid x-api-key sk-ant-secret-key; Groq: quota")
    );

    const res = await app.request("/api/admin/test-llm", {
      method: "GET",
      headers: adminHeaders,
    });

    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.error).toBe("LLM test failed");
    expect(json.error).not.toContain("All LLM providers failed");
    expect(json.error).not.toContain("sk-ant-secret-key");
    expect(json.error).not.toContain("Anthropic");
  });

  it("still fails closed for unauthenticated callers (no admin token header)", async () => {
    const res = await app.request("/api/admin/test-llm", { method: "GET" });
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error).toBe("Unauthorized");
  });
});
