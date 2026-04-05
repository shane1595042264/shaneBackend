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

  /**
   * Convert IANA timezone to RFC3339 offset string (e.g. "-05:00")
   */
  private getTimezoneOffset(date: string): string {
    const dt = new Date(`${date}T12:00:00Z`);
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: this.timezone,
      timeZoneName: "shortOffset",
    });
    const parts = formatter.formatToParts(dt);
    const tzPart = parts.find((p) => p.type === "timeZoneName");
    if (!tzPart) return "Z";
    // tzPart.value is like "GMT-5" or "GMT+5:30" or "GMT"
    const match = tzPart.value.match(/GMT([+-]\d{1,2}(?::?\d{2})?)?/);
    if (!match || !match[1]) return "+00:00";
    const sign = match[1][0];
    const rest = match[1].slice(1);
    const [h, m] = rest.includes(":") ? rest.split(":") : [rest, "0"];
    return `${sign}${h.padStart(2, "0")}:${(m || "0").padStart(2, "0")}`;
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

    // Build timezone offset string from IANA timezone for RFC3339 compliance
    const tzOffset = this.getTimezoneOffset(date);
    const timeMin = `${date}T00:00:00${tzOffset}`;
    const timeMax = `${date}T23:59:59${tzOffset}`;

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
