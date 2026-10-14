import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";

const mocks = vi.hoisted(() => ({
  processWeChatMessages: vi.fn(),
  where: vi.fn(),
}));

vi.mock("@/modules/integrations/wechat", () => ({
  processWeChatMessages: mocks.processWeChatMessages,
}));

vi.mock("@/db/client", () => ({
  db: { select: () => ({ from: () => ({ where: mocks.where }) }) },
}));

vi.mock("@/db/schema", () => ({
  activities: { date: "date", source: "source" },
}));

import { wechatRoutes } from "@/modules/integrations/wechat-routes";

const app = new Hono().route("/api/integrations/wechat", wechatRoutes);

const message = {
  content: "hello",
  sender: "self",
  chat: "Family Group",
  timestamp: "2026-10-13T12:00:00Z",
};

function post(body: unknown, auth?: string) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (auth) headers.Authorization = auth;
  return app.request("/api/integrations/wechat/messages", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

function today(auth?: string) {
  return app.request("/api/integrations/wechat/today", {
    headers: auth ? { Authorization: auth } : {},
  });
}

describe("WeChat routes fail closed (SHAN-572)", () => {
  const original = process.env.WECHAT_INGEST_TOKEN;

  beforeEach(() => {
    mocks.processWeChatMessages.mockReset().mockResolvedValue(1);
    mocks.where.mockReset().mockResolvedValue([]);
    delete process.env.WECHAT_INGEST_TOKEN;
  });
  afterEach(() => {
    if (original === undefined) delete process.env.WECHAT_INGEST_TOKEN;
    else process.env.WECHAT_INGEST_TOKEN = original;
  });

  it("rejects ingest when WECHAT_INGEST_TOKEN is unset, with or without a header", async () => {
    expect((await post({ messages: [message] })).status).toBe(401);
    expect((await post({ messages: [message] }, "Bearer anything")).status).toBe(401);
    expect(mocks.processWeChatMessages).not.toHaveBeenCalled();
  });

  it("rejects the debug read when WECHAT_INGEST_TOKEN is unset", async () => {
    expect((await today()).status).toBe(401);
    expect(mocks.where).not.toHaveBeenCalled();
  });

  it("rejects a wrong token", async () => {
    process.env.WECHAT_INGEST_TOKEN = "s3cret";
    expect((await post({ messages: [message] }, "Bearer wrong!")).status).toBe(401);
    expect((await today("Bearer wrong!")).status).toBe(401);
    expect(mocks.processWeChatMessages).not.toHaveBeenCalled();
  });

  it("answers 401 before validating the body", async () => {
    process.env.WECHAT_INGEST_TOKEN = "s3cret";
    expect((await post({ messages: [] })).status).toBe(401);
  });

  it("accepts the matching token on both routes", async () => {
    process.env.WECHAT_INGEST_TOKEN = "s3cret";
    const res = await post({ messages: [message] }, "Bearer s3cret");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, inserted: 1, total: 1 });
    expect((await today("Bearer s3cret")).status).toBe(200);
  });

  it("still validates the body once authed", async () => {
    process.env.WECHAT_INGEST_TOKEN = "s3cret";
    expect((await post({ messages: [] }, "Bearer s3cret")).status).toBe(400);
  });
});
