import type { NormalizedActivity, IntegrationConnector } from "./types";

export class GoogleCalendarConnector implements IntegrationConnector {
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

    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });

    if (!response.ok) {
      throw new Error(
        `Google token refresh failed: ${response.status} ${response.statusText}`
      );
    }

    const data = await response.json() as { access_token: string };
    return data.access_token;
  }

  async fetchActivities(date: string): Promise<NormalizedActivity[]> {
    const accessToken = await this.getAccessToken();

    const timeMin = `${date}T00:00:00Z`;
    const timeMax = `${date}T23:59:59Z`;

    const params = new URLSearchParams({
      timeMin,
      timeMax,
    });

    const url = `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params.toString()}`;

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!response.ok) {
      throw new Error(
        `Google Calendar events fetch failed: ${response.status} ${response.statusText}`
      );
    }

    const data = await response.json() as {
      items: Array<{
        id: string;
        summary: string;
        location?: string;
        start: { dateTime: string };
        end: { dateTime: string };
      }>;
    };

    return data.items.map((event) => ({
      date,
      source: "google_calendar" as const,
      type: "calendar_event",
      data: {
        id: event.id,
        title: event.summary,
        location: event.location ?? null,
        startTime: event.start.dateTime,
        endTime: event.end.dateTime,
      },
    }));
  }
}
