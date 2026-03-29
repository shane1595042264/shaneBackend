import { db } from "@/db/client";
import { activities } from "@/db/schema";
import { GitHubConnector } from "@/modules/integrations/github";
import { StravaConnector } from "@/modules/integrations/strava";
import { GoogleCalendarConnector } from "@/modules/integrations/google-calendar";
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
    } catch (err) {
      console.error(`[ingest] Connector failed for date ${date}:`, err);
    }
  }

  console.log(`[ingest] Ingested ${totalCount} activities for ${date}`);
  return totalCount;
}
