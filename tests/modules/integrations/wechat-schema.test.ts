import { describe, it, expect } from "vitest";
import { wechatMessageSchema, wechatBatchSchema } from "@/modules/integrations/wechat-routes";

const validMessage = {
  content: "hello from the family group",
  sender: "self",
  chat: "Family Group",
  timestamp: "2026-07-20T12:00:00Z",
  messageType: "text",
  url: "https://example.com/link",
};

describe("wechatMessageSchema bounds", () => {
  it("accepts a normal message", () => {
    expect(wechatMessageSchema.safeParse(validMessage).success).toBe(true);
  });

  it("accepts empty content (e.g. sticker/image with no text)", () => {
    expect(wechatMessageSchema.safeParse({ ...validMessage, content: "" }).success).toBe(true);
  });

  it("accepts a message with optional fields omitted", () => {
    const { messageType, url, ...rest } = validMessage;
    expect(wechatMessageSchema.safeParse(rest).success).toBe(true);
  });

  it("rejects oversized content (> 10000 chars)", () => {
    expect(wechatMessageSchema.safeParse({ ...validMessage, content: "x".repeat(10_001) }).success).toBe(false);
  });

  it("rejects oversized sender (> 255 chars)", () => {
    expect(wechatMessageSchema.safeParse({ ...validMessage, sender: "x".repeat(256) }).success).toBe(false);
  });

  it("rejects oversized chat (> 255 chars)", () => {
    expect(wechatMessageSchema.safeParse({ ...validMessage, chat: "x".repeat(256) }).success).toBe(false);
  });

  it("rejects oversized timestamp (> 64 chars)", () => {
    expect(wechatMessageSchema.safeParse({ ...validMessage, timestamp: "x".repeat(65) }).success).toBe(false);
  });

  it("rejects oversized url (> 2048 chars)", () => {
    expect(wechatMessageSchema.safeParse({ ...validMessage, url: "x".repeat(2049) }).success).toBe(false);
  });
});

describe("wechatBatchSchema bounds", () => {
  it("accepts a batch of valid messages", () => {
    expect(wechatBatchSchema.safeParse({ messages: [validMessage] }).success).toBe(true);
  });

  it("rejects an empty batch", () => {
    expect(wechatBatchSchema.safeParse({ messages: [] }).success).toBe(false);
  });

  it("rejects a batch larger than 500 messages", () => {
    const messages = Array.from({ length: 501 }, () => validMessage);
    expect(wechatBatchSchema.safeParse({ messages }).success).toBe(false);
  });
});
