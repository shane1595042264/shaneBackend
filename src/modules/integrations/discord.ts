import type { NormalizedActivity, IntegrationConnector } from "./types";

/**
 * Convert a Date to a Discord snowflake ID.
 * Discord epoch: 2015-01-01T00:00:00.000Z (1420070400000 ms).
 */
function dateToSnowflake(date: Date): string {
  const discordEpoch = 1420070400000n;
  const timestamp = BigInt(date.getTime()) - discordEpoch;
  return (timestamp << 22n).toString();
}

interface DiscordMessage {
  id: string;
  content: string;
  author: { id: string; username: string };
  channel_id: string;
  timestamp: string;
  attachments: Array<{ url: string; content_type?: string }>;
  type: number; // 0 = default, 19 = reply, etc.
}

export class DiscordConnector implements IntegrationConnector {
  private botToken: string;
  private userId: string;
  private channelIds: string[];

  constructor(botToken: string, userId: string, channelIds: string[]) {
    this.botToken = botToken;
    this.userId = userId;
    this.channelIds = channelIds;
  }

  async fetchActivities(date: string): Promise<NormalizedActivity[]> {
    const dayStart = new Date(`${date}T00:00:00.000Z`);
    const dayEnd = new Date(`${date}T23:59:59.999Z`);
    const afterSnowflake = dateToSnowflake(dayStart);

    const allActivities: NormalizedActivity[] = [];

    for (const channelId of this.channelIds) {
      const messages = await this.fetchChannelMessages(
        channelId,
        afterSnowflake
      );

      const filtered = messages.filter((msg) => {
        if (msg.author.id !== this.userId) return false;
        const msgTime = new Date(msg.timestamp);
        return msgTime >= dayStart && msgTime <= dayEnd;
      });

      for (const msg of filtered) {
        if (!msg.content && msg.attachments.length === 0) continue;

        allActivities.push({
          date,
          source: "discord" as const,
          type: "message",
          data: {
            messageId: msg.id,
            channelId: msg.channel_id,
            content: msg.content,
            timestamp: msg.timestamp,
            hasAttachments: msg.attachments.length > 0,
            attachmentCount: msg.attachments.length,
          },
        });
      }
    }

    return allActivities;
  }

  private async fetchChannelMessages(
    channelId: string,
    afterSnowflake: string
  ): Promise<DiscordMessage[]> {
    const allMessages: DiscordMessage[] = [];
    let after = afterSnowflake;

    // Paginate through messages (max 100 per request, up to 500 total)
    for (let page = 0; page < 5; page++) {
      const url = `https://discord.com/api/v10/channels/${channelId}/messages?after=${after}&limit=100`;
      const response = await fetch(url, {
        headers: { Authorization: `Bot ${this.botToken}` },
      });

      if (!response.ok) {
        if (response.status === 403 || response.status === 404) {
          console.warn(
            `[discord] Cannot access channel ${channelId}: ${response.status}`
          );
          break;
        }
        throw new Error(
          `Discord API error: ${response.status} ${response.statusText}`
        );
      }

      const messages = (await response.json()) as DiscordMessage[];
      if (messages.length === 0) break;

      allMessages.push(...messages);

      // Discord returns messages newest-first when using `after`, so the
      // last element has the lowest ID. But we need the highest ID for
      // pagination. Sort by ID descending and take the max.
      const maxId = messages.reduce((max, m) =>
        BigInt(m.id) > BigInt(max.id) ? m : max
      ).id;
      after = maxId;

      if (messages.length < 100) break;
    }

    return allMessages;
  }
}
