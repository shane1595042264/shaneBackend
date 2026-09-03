import type { NormalizedActivity, IntegrationConnector } from "./types";

const STRAVA_API_SETTINGS_URL = "https://www.strava.com/settings/api";

/**
 * Strava error bodies carry the real reason a request failed; the status line
 * alone is ambiguous (a 403 is scope trouble, a disabled app, or a banned
 * token). Read it defensively so a failure never masks itself.
 */
async function readErrorBody(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.trim().slice(0, 300);
  } catch {
    return "";
  }
}

/**
 * Strava marks an API application "Inactive" when it has not accepted the
 * current API agreement. Every request then 403s no matter how fresh the
 * token is, so retrying is pointless until Shane reactivates the app.
 */
function isApplicationInactive(body: string): boolean {
  try {
    const parsed = JSON.parse(body) as {
      errors?: Array<{ resource?: string; code?: string }>;
    };
    return (parsed.errors ?? []).some(
      (e) => e.resource === "Application" && e.code === "Inactive"
    );
  } catch {
    return false;
  }
}

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
      const body = await readErrorBody(response);
      throw new Error(
        `Strava token refresh failed: ${response.status} ${response.statusText}` +
          (body ? ` - ${body}` : "")
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
      const body = await readErrorBody(response);

      if (response.status === 403 && isApplicationInactive(body)) {
        console.warn(
          `[strava] Skipping ingest: the Strava API application is marked Inactive, ` +
            `so every request 403s regardless of token. Reactivate it at ` +
            `${STRAVA_API_SETTINGS_URL} (accept the current API agreement); ` +
            `ingest resumes on its own once it is active.`
        );
        return [];
      }

      throw new Error(
        `Strava activities fetch failed: ${response.status} ${response.statusText}` +
          (body ? ` - ${body}` : "")
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
