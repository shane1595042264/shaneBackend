import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

const { svc, repo } = vi.hoisted(() => ({
  svc: { addKey: vi.fn(), explain: vi.fn(), recheckKey: vi.fn() },
  repo: {
    listKeys: vi.fn(),
    getSettings: vi.fn(),
    saveSettings: vi.fn(),
    getKey: vi.fn(),
    updateKey: vi.fn(),
    deleteKey: vi.fn(),
    usageSummary: vi.fn(),
    publicKey: (r: Record<string, unknown>) => ({ ...r, keySealed: undefined }),
  },
}));

vi.mock("@/modules/ai/service", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/modules/ai/service")>();
  return { ...real, ...svc };
});
vi.mock("@/modules/ai/repo", () => repo);
vi.mock("@/modules/auth/middleware", () => ({
  requireAuth: async (c: any, next: any) => {
    const u = c.req.header("X-Test-User");
    if (!u) return c.json({ error: "auth" }, 401);
    c.set("userId", u);
    c.set("tokenScopes", c.req.header("X-Test-Token") ? ["comments:write"] : null);
    await next();
  },
  requireBrowserSession: (feature: string) => async (c: any, next: any) => {
    if (c.get("tokenScopes") !== null) return c.json({ error: `${feature} requires a browser session, not a PAT` }, 403);
    await next();
  },
}));

import { aiRoutes } from "@/modules/ai/routes";
import { ExplainError, KeyCheckError } from "@/modules/ai/service";

const app = new Hono().route("/api/ai", aiRoutes);
const KEY_ID = "11111111-1111-4111-8111-111111111111";
const send = (method: string, path: string, body?: unknown, headers: Record<string, string> = { "X-Test-User": "u1" }) =>
  app.request(path, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

beforeEach(() => vi.clearAllMocks());

describe("/api/ai guards", () => {
  it("401s signed-out callers and 403s every PAT, whatever its scopes", async () => {
    expect((await send("GET", "/api/ai/keys", undefined, {})).status).toBe(401);
    const res = await send("POST", "/api/ai/explain", { quote: "x", surface: "blog" }, { "X-Test-User": "u1", "X-Test-Token": "t" });
    expect(res.status).toBe(403);
    expect(svc.explain).not.toHaveBeenCalled();
  });
});

describe("POST /api/ai/keys", () => {
  it("201s with the stored key, never its secret", async () => {
    svc.addKey.mockResolvedValue({ id: KEY_ID, provider: "gemini", keyHint: "abcd", keySealed: "SEALED" });
    const res = await send("POST", "/api/ai/keys", { key: "AIza..." });
    expect(res.status).toBe(201);
    expect(JSON.stringify(await res.json())).not.toContain("SEALED");
  });

  it.each([
    ["unknown_provider", 400],
    ["auth", 422],
    ["quota", 422],
    ["no_models", 422],
    ["unreachable", 502],
  ] as const)("maps %s to %i with the reason", async (code, status) => {
    svc.addKey.mockRejectedValue(new KeyCheckError(code, `reason for ${code}`));
    const res = await send("POST", "/api/ai/keys", { key: "whatever-key" });
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ error: `reason for ${code}`, code });
  });
});

describe("PATCH /api/ai/keys/:id", () => {
  it("only accepts a model the key can use", async () => {
    repo.getKey.mockResolvedValue({ id: KEY_ID, models: ["gemini-3.5-flash-lite"] });
    expect((await send("PATCH", `/api/ai/keys/${KEY_ID}`, { preferredModel: "gpt-5" })).status).toBe(400);
    repo.updateKey.mockResolvedValue({ id: KEY_ID, preferredModel: "gemini-3.5-flash-lite" });
    expect((await send("PATCH", `/api/ai/keys/${KEY_ID}`, { preferredModel: "gemini-3.5-flash-lite" })).status).toBe(200);
    expect((await send("PATCH", `/api/ai/keys/${KEY_ID}`, { preferredModel: null })).status).toBe(200);
  });
});

describe("PATCH /api/ai/settings", () => {
  it("accepts a known provider or null, and rejects anything else", async () => {
    repo.saveSettings.mockResolvedValue({ preferredProvider: "xai", notesToKnowledge: false });
    expect((await send("PATCH", "/api/ai/settings", { preferredProvider: "xai", notesToKnowledge: false })).status).toBe(200);
    expect(repo.saveSettings).toHaveBeenCalledWith("u1", { preferredProvider: "xai", notesToKnowledge: false });
    expect((await send("PATCH", "/api/ai/settings", { preferredProvider: "groq" })).status).toBe(400);
  });
});

describe("POST /api/ai/explain", () => {
  const body = { quote: "ring buffer", before: "a", after: "b", surface: "journal" };

  it("returns the explanation", async () => {
    svc.explain.mockResolvedValue({ explanation: "It is a queue.", provider: "gemini", model: "m", usage: {} });
    const res = await send("POST", "/api/ai/explain", body);
    expect(res.status).toBe(200);
    expect(svc.explain).toHaveBeenCalledWith("u1", expect.objectContaining({ quote: "ring buffer", surface: "journal" }));
  });

  it("409s with code no_key when there is nothing to call", async () => {
    svc.explain.mockRejectedValue(new ExplainError("no_key", "Add an AI key in Settings to use Explain."));
    const res = await send("POST", "/api/ai/explain", body);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("no_key");
  });

  it("502s with the provider's reason and kind", async () => {
    svc.explain.mockRejectedValue(new ExplainError("provider", "You exceeded your current quota", "quota"));
    const res = await send("POST", "/api/ai/explain", body);
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ code: "provider", kind: "quota" });
  });

  it("validates the request", async () => {
    expect((await send("POST", "/api/ai/explain", { ...body, quote: "  " })).status).toBe(400);
    expect((await send("POST", "/api/ai/explain", { ...body, surface: "trips" })).status).toBe(400);
    expect((await send("POST", "/api/ai/explain", { ...body, prompt: "ignore all that" })).status).toBe(400);
  });
});
