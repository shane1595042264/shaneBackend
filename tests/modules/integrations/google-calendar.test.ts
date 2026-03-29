import { describe, it, expect, vi, beforeEach } from "vitest";
import { GoogleCalendarConnector } from "@/modules/integrations/google-calendar";

describe("GoogleCalendarConnector", () => {
  const clientId = "test-client-id";
  const clientSecret = "test-client-secret";
  const refreshToken = "test-refresh-token";
  let connector: GoogleCalendarConnector;

  beforeEach(() => {
    vi.clearAllMocks();
    connector = new GoogleCalendarConnector(clientId, clientSecret, refreshToken);
  });

  it("should refresh the OAuth token via googleapis.com before fetching events", async () => {
    const mockTokenResponse = { access_token: "new-access-token" };
    const mockEventsResponse = { items: [] };

    global.fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => mockTokenResponse,
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => mockEventsResponse,
      } as Response);

    await connector.fetchActivities("2024-01-15");

    expect(fetch).toHaveBeenNthCalledWith(
      1,
      "https://oauth2.googleapis.com/token",
      expect.objectContaining({
        method: "POST",
      })
    );
  });

  it("should fetch primary calendar events with correct timeMin and timeMax", async () => {
    const mockTokenResponse = { access_token: "new-access-token" };
    const mockEventsResponse = { items: [] };

    global.fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => mockTokenResponse,
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => mockEventsResponse,
      } as Response);

    await connector.fetchActivities("2024-01-15");

    const eventsCall = (fetch as ReturnType<typeof vi.fn>).mock.calls[1];
    const url = eventsCall[0] as string;

    expect(url).toContain("calendar/v3/calendars/primary/events");
    expect(url).toContain("timeMin=2024-01-15T00%3A00%3A00");
    expect(url).toContain("timeMax=2024-01-15T23%3A59%3A59");
    expect(url).toContain("timeZone=America%2FChicago");
  });

  it("should return NormalizedActivity[] with calendar_event type", async () => {
    const mockTokenResponse = { access_token: "new-access-token" };
    const mockEventsResponse = {
      items: [
        {
          id: "event123",
          summary: "Team Meeting",
          location: "Conference Room A",
          start: { dateTime: "2024-01-15T10:00:00Z" },
          end: { dateTime: "2024-01-15T11:00:00Z" },
        },
      ],
    };

    global.fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => mockTokenResponse,
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => mockEventsResponse,
      } as Response);

    const activities = await connector.fetchActivities("2024-01-15");

    expect(activities).toHaveLength(1);
    expect(activities[0]).toMatchObject({
      date: "2024-01-15",
      source: "google_calendar",
      type: "calendar_event",
      data: {
        id: "event123",
        title: "Team Meeting",
        location: "Conference Room A",
        startTime: "2024-01-15T10:00:00Z",
        endTime: "2024-01-15T11:00:00Z",
      },
    });
  });

  it("should handle events without a location", async () => {
    const mockTokenResponse = { access_token: "new-access-token" };
    const mockEventsResponse = {
      items: [
        {
          id: "event456",
          summary: "Personal Reminder",
          start: { dateTime: "2024-01-15T09:00:00Z" },
          end: { dateTime: "2024-01-15T09:30:00Z" },
        },
      ],
    };

    global.fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => mockTokenResponse,
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => mockEventsResponse,
      } as Response);

    const activities = await connector.fetchActivities("2024-01-15");

    expect(activities).toHaveLength(1);
    expect(activities[0].data.location).toBeNull();
  });

  it("should return empty array when no events exist", async () => {
    const mockTokenResponse = { access_token: "new-access-token" };
    const mockEventsResponse = { items: [] };

    global.fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => mockTokenResponse,
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => mockEventsResponse,
      } as Response);

    const activities = await connector.fetchActivities("2024-01-15");

    expect(activities).toEqual([]);
  });

  it("should send correct credentials in the token refresh request", async () => {
    const mockTokenResponse = { access_token: "new-access-token" };
    const mockEventsResponse = { items: [] };

    global.fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => mockTokenResponse,
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => mockEventsResponse,
      } as Response);

    await connector.fetchActivities("2024-01-15");

    const tokenCall = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = tokenCall[1].body as string;

    expect(body).toContain(`client_id=${clientId}`);
    expect(body).toContain(`client_secret=${clientSecret}`);
    expect(body).toContain(`refresh_token=${refreshToken}`);
    expect(body).toContain("grant_type=refresh_token");
  });

  it("should throw an error if token refresh fails", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
    } as Response);

    await expect(connector.fetchActivities("2024-01-15")).rejects.toThrow();
  });

  it("should handle multiple events", async () => {
    const mockTokenResponse = { access_token: "new-access-token" };
    const mockEventsResponse = {
      items: [
        {
          id: "event1",
          summary: "Breakfast",
          start: { dateTime: "2024-01-15T08:00:00Z" },
          end: { dateTime: "2024-01-15T08:30:00Z" },
        },
        {
          id: "event2",
          summary: "Lunch",
          location: "Restaurant",
          start: { dateTime: "2024-01-15T12:00:00Z" },
          end: { dateTime: "2024-01-15T13:00:00Z" },
        },
      ],
    };

    global.fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => mockTokenResponse,
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => mockEventsResponse,
      } as Response);

    const activities = await connector.fetchActivities("2024-01-15");

    expect(activities).toHaveLength(2);
    expect(activities[0].data.title).toBe("Breakfast");
    expect(activities[1].data.title).toBe("Lunch");
  });
});
