import type { NormalizedActivity, IntegrationConnector } from "./types";

/**
 * Where a human goes to mint a replacement refresh token. The full procedure
 * (own-credentials toggle, calendar.readonly scope, which Google account to
 * authorize with) lives under "Google Calendar OAuth" in the root CLAUDE.md;
 * this is the entry point that link-chases to the rest of it.
 */
const OAUTH_PLAYGROUND_URL = "https://developers.google.com/oauthplayground";

/**
 * Google's token endpoint puts the real reason in the response body; the status
 * line alone cannot tell a revoked refresh token apart from a wrong client
 * secret, since both come back 400. Read it defensively - a body that is
 * unreadable or already consumed must not mask the failure it describes.
 *
 * Mirrors readErrorBody() in ./strava.ts, which exists for the same reason.
 */
async function readTokenError(
  response: Response,
): Promise<{ error: string; description: string; raw: string }> {
  let raw = "";
  try {
    raw = (await response.text()).trim().slice(0, 300);
  } catch {
    return { error: "", description: "", raw: "" };
  }
  try {
    const parsed = JSON.parse(raw) as {
      error?: string;
      error_description?: string;
    };
    return {
      error: parsed.error ?? "",
      description: parsed.error_description ?? "",
      raw,
    };
  } catch {
    return { error: "", description: "", raw };
  }
}

/**
 * Raised when the token exchange fails, carrying the OAuth error code so the
 * caller can tell a permanently dead credential apart from a transient blip
 * without re-parsing a message string.
 */
class GoogleTokenError extends Error {
  readonly oauthError: string;

  constructor(message: string, oauthError: string) {
    super(message);
    this.name = "GoogleTokenError";
    this.oauthError = oauthError;
  }
}

export class GoogleCalendarConnector implements IntegrationConnector {
  readonly name = "google_calendar";
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
      const { error, description, raw } = await readTokenError(response);
      const detail = error
        ? ` - ${error}${description ? `: ${description}` : ""}`
        : raw
          ? ` - ${raw}`
          : "";
      throw new GoogleTokenError(
        `Google token refresh failed: ${response.status} ${response.statusText}${detail}`,
        error,
      );
    }

    const data = (await response.json()) as { access_token: string };
    return data.access_token;
  }

  async fetchActivities(date: string): Promise<NormalizedActivity[]> {
    let accessToken: string;
    try {
      accessToken = await this.getAccessToken();
    } catch (err) {
      // invalid_grant means the refresh token itself is expired or revoked, not
      // that the request went wrong. No retry can recover it - a human has to
      // re-authorize - so every subsequent run would throw the identical stack
      // trace, six times a day, forever. That is exactly what happened between
      // 2026-09-17 and 2026-09-20 (SHAN-511), and a permanently red integration
      // is what makes a genuinely new error easy to miss in the log stream.
      //
      // Degrade to the Strava precedent instead: one actionable warn line, and
      // an empty result so the rest of the ingest run carries on. Ingest resumes
      // on its own once GOOGLE_CALENDAR_REFRESH_TOKEN is replaced.
      if (err instanceof GoogleTokenError && err.oauthError === "invalid_grant") {
        console.warn(
          `[google_calendar] Skipping ingest: the OAuth refresh token is expired ` +
            `or revoked (invalid_grant), so every token exchange 400s until it is ` +
            `replaced. Mint a new one at ${OAUTH_PLAYGROUND_URL} (scope ` +
            `https://www.googleapis.com/auth/calendar.readonly) and update ` +
            `GOOGLE_CALENDAR_REFRESH_TOKEN in .env and in the Railway env vars; ` +
            `ingest resumes on its own once it is valid.`,
        );
        return [];
      }
      throw err;
    }

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
