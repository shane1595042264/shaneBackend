import { db } from "@/db/client";
import { activities } from "@/db/schema";
import { GitHubConnector } from "@/modules/integrations/github";
import { StravaConnector } from "@/modules/integrations/strava";
import { GoogleCalendarConnector } from "@/modules/integrations/google-calendar";
import { TwitchConnector } from "@/modules/integrations/twitch";
import { DiscordConnector } from "@/modules/integrations/discord";
import type { IntegrationConnector } from "@/modules/integrations/types";

export async function ingestActivities(date: string): Promise<number> {
  const connectors: IntegrationConnector[] = [];

  if (process.env.GITHUB_TOKEN) {
    connectors.push(new GitHubConnector(process.env.GITHUB_TOKEN));
  }

  if (
    process.env.STRAVA_CLIENT_ID &&
    process.env.STRAVA_CLIENT_SECRET &&
    process.env.STRAVA_REFRESH_TOKEN
  ) {
    connectors.push(
      new StravaConnector(
        process.env.STRAVA_CLIENT_ID,
        process.env.STRAVA_CLIENT_SECRET,
        process.env.STRAVA_REFRESH_TOKEN
      )
    );
  }

  if (
    process.env.GOOGLE_CALENDAR_CLIENT_ID &&
    process.env.GOOGLE_CALENDAR_CLIENT_SECRET &&
    process.env.GOOGLE_CALENDAR_REFRESH_TOKEN
  ) {
    connectors.push(
      new GoogleCalendarConnector(
        process.env.GOOGLE_CALENDAR_CLIENT_ID,
        process.env.GOOGLE_CALENDAR_CLIENT_SECRET,
        process.env.GOOGLE_CALENDAR_REFRESH_TOKEN,
        process.env.GOOGLE_CALENDAR_ID || "primary"
      )
    );
  }

  if (
    process.env.TWITCH_CLIENT_ID &&
    process.env.TWITCH_CLIENT_SECRET &&
    process.env.TWITCH_USER_ID
  ) {
    connectors.push(
      new TwitchConnector(
        process.env.TWITCH_CLIENT_ID,
        process.env.TWITCH_CLIENT_SECRET,
        process.env.TWITCH_USER_ID
      )
    );
  }

  if (
    process.env.DISCORD_BOT_TOKEN &&
    process.env.DISCORD_USER_ID &&
    process.env.DISCORD_CHANNEL_IDS
  ) {
    connectors.push(
      new DiscordConnector(
        process.env.DISCORD_BOT_TOKEN,
        process.env.DISCORD_USER_ID,
        process.env.DISCORD_CHANNEL_IDS.split(",").map((id) => id.trim())
      )
    );
  }

  let totalCount = 0;

  for (const connector of connectors) {
    try {
      const fetched = await connector.fetchActivities(date);

      if (fetched.length > 0) {
        await db
          .insert(activities)
          .values(fetched)
          .onConflictDoNothing();
      }

      totalCount += fetched.length;
      console.log(
        `[ingest] ${connector.name} fetched ${fetched.length} activities for ${date}`
      );
    } catch (err) {
      console.error(
        `[ingest] ${connector.name} failed for date ${date}:`,
        err
      );
    }
  }

  console.log(`[ingest] Ingested ${totalCount} activities for ${date}`);
  return totalCount;
}
