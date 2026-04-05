import type { NormalizedActivity } from "./types";
import { db } from "@/db/client";
import { activities } from "@/db/schema";

/**
 * Payload for a single WeChat message pushed via API.
 */
export interface WeChatMessagePayload {
  /** The message content (text messages only for now) */
  content: string;
  /** Who sent it: "self" for Shane's own messages, or a contact name */
  sender: string;
  /** Chat/group name (e.g. "Family Group", "John Doe") */
  chat: string;
  /** ISO 8601 timestamp of the message */
  timestamp: string;
  /** Message type: "text", "image", "voice", "link", "sticker" */
  messageType?: string;
  /** Optional: URL if the message shared a link */
  url?: string;
}

function toDateString(isoTimestamp: string): string {
  return new Date(isoTimestamp).toISOString().split("T")[0];
}

/**
 * Process a batch of WeChat messages and store them as normalized activities.
 * Returns the number of messages successfully stored.
 */
export async function processWeChatMessages(
  messages: WeChatMessagePayload[]
): Promise<number> {
  if (messages.length === 0) return 0;

  const normalizedActivities: NormalizedActivity[] = messages.map((msg) => ({
    date: toDateString(msg.timestamp),
    source: "wechat" as const,
    type: msg.messageType ?? "text",
    data: {
      content: msg.content,
      sender: msg.sender,
      chat: msg.chat,
      timestamp: msg.timestamp,
      url: msg.url ?? null,
    },
  }));

  // Group by date and insert
  let inserted = 0;
  for (const activity of normalizedActivities) {
    try {
      await db
        .insert(activities)
        .values({
          date: activity.date,
          source: activity.source,
          type: activity.type,
          data: activity.data,
        })
        .onConflictDoNothing();
      inserted++;
    } catch (err) {
      console.error("[wechat] Failed to insert message:", err);
    }
  }

  console.log(`[wechat] Stored ${inserted}/${messages.length} messages`);
  return inserted;
}
