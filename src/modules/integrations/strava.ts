import type { NormalizedActivity, IntegrationConnector } from "./types";

export class StravaConnector implements IntegrationConnector {
  readonly name = "strava";
  private clientId: string;
  private clientSecret: string;
  private refreshToken: string;

  constructor(clientId: string, clientSecret: string, refreshToken: string) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.refreshToken = refreshToken;
  }

  private async getAccessToken(): Promise<string> {
    const body = new URLSearchParams({
      client_id: this.clientId,
      client_secret: this.clientSecret,
      refresh_token: this.refreshToken,
      grant_type: "refresh_token",
    });

    const response = await fetch("https://www.strava.com/oauth/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });

    if (!response.ok) {
      throw new Error(
        `Strava token refresh failed: ${response.status} ${response.statusText}`
      );
    }

    const data = await response.json() as { access_token: string };
    return data.access_token;
  }

  async fetchActivities(date: string): Promise<NormalizedActivity[]> {
    const accessToken = await this.getAccessToken();

    const after = Math.floor(new Date(`${date}T00:00:00Z`).getTime() / 1000);
    const before = Math.floor(
      new Date(`${date}T00:00:00Z`).getTime() / 1000 + 86400
    );

    const url = `https://www.strava.com/api/v3/athlete/activities?after=${after}&before=${before}`;

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!response.ok) {
      throw new Error(
        `Strava activities fetch failed: ${response.status} ${response.statusText}`
      );
    }

    const activities = await response.json() as Array<{
      id: number;
      name: string;
      type: string;
      distance: number;
      moving_time: number;
      start_date: string;
      average_heartrate: number | null;
      map: { summary_polyline: string };
    }>;

    return activities.map((activity) => ({
      date,
      source: "strava" as const,
      type: activity.type.toLowerCase(),
      data: {
        id: activity.id,
        name: activity.name,
        activityType: activity.type,
        distanceMeters: activity.distance,
        movingTimeSeconds: activity.moving_time,
        startTime: activity.start_date,
        averageHeartrate: activity.average_heartrate,
        polyline: activity.map.summary_polyline,
      },
    }));
  }
}
