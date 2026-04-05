import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { processWeChatMessages } from "./wechat";

export const wechatRoutes = new Hono();

const wechatMessageSchema = z.object({
  content: z.string(),
  sender: z.string(),
  chat: z.string(),
  timestamp: z.string(),
  messageType: z.string().optional(),
  url: z.string().optional(),
});

const wechatBatchSchema = z.object({
  messages: z.array(wechatMessageSchema).min(1).max(500),
});

/**
 * POST /messages
 * Push WeChat messages into the activities table.
 * Auth: Bearer token via WECHAT_INGEST_TOKEN env var.
 *
 * Body: { messages: [{ content, sender, chat, timestamp, messageType?, url? }] }
 */
wechatRoutes.post("/messages", zValidator("json", wechatBatchSchema), async (c) => {
  const expectedToken = process.env.WECHAT_INGEST_TOKEN;
  if (expectedToken) {
    const auth = c.req.header("Authorization");
    if (auth !== `Bearer ${expectedToken}`) {
      return c.json({ error: "Unauthorized" }, 401);
    }
  }

  const { messages } = c.req.valid("json");
  const inserted = await processWeChatMessages(messages);

  return c.json({ ok: true, inserted, total: messages.length });
});

/**
 * GET /today
 * Get all WeChat messages for today (for debugging).
 */
wechatRoutes.get("/today", async (c) => {
  const { db } = await import("@/db/client");
  const { activities } = await import("@/db/schema");
  const { eq, and } = await import("drizzle-orm");

  const today = new Date().toISOString().split("T")[0];

  const msgs = await db
    .select()
    .from(activities)
    .where(and(eq(activities.date, today), eq(activities.source, "wechat")));

  return c.json({ date: today, count: msgs.length, messages: msgs });
});
