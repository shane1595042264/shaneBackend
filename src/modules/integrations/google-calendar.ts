import type { NormalizedActivity, IntegrationConnector } from "./types";

export class GoogleCalendarConnector implements IntegrationConnector {
  private clientId: string;
  private clientSecret: string;
  private refreshToken: string;
  private calendarId: string;
  private timezone: string;

  constructor(clientId: string, clientSecret: string, refreshToken: string, calendarId?: string, timezone?: string) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.refreshToken = refreshToken;
    this.calendarId = calendarId || "primary";
    this.timezone = timezone || "America/Chicago";
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
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });

    if (!response.ok) {
      throw new Error(`Google token refresh failed: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as { access_token: string };
    return data.access_token;
  }

  async fetchActivities(date: string): Promise<NormalizedActivity[]> {
    const accessToken = await this.getAccessToken();

    // Use timezone-aware time range to avoid UTC offset issues
    const timeMin = `${date}T00:00:00`;
    const timeMax = `${date}T23:59:59`;

    const params = new URLSearchParams({
      timeMin,
      timeMax,
      timeZone: this.timezone,
      singleEvents: "true",
      orderBy: "startTime",
    });

    const calId = encodeURIComponent(this.calendarId);
    const url = `https://www.googleapis.com/calendar/v3/calendars/${calId}/events?${params.toString()}`;

    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!response.ok) {
      throw new Error(`Google Calendar events fetch failed: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as {
      items?: Array<{
        id: string;
        summary?: string;
        location?: string;
        start: { dateTime?: string; date?: string };
        end: { dateTime?: string; date?: string };
      }>;
    };

    // Strict filter: only include events that actually start on this date
    return (data.items || [])
      .filter((event) => {
        const startStr = event.start.dateTime || event.start.date || "";
        return startStr.startsWith(date);
      })
      .map((event) => ({
        date,
        source: "google_calendar" as const,
        type: "calendar_event",
        data: {
          id: event.id,
          title: event.summary || "Untitled",
          location: event.location ?? null,
          startTime: event.start.dateTime || event.start.date || null,
          endTime: event.end.dateTime || event.end.date || null,
        },
      }));
  }
}
