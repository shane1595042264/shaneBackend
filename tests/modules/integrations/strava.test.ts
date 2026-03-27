import { describe, it, expect, vi, beforeEach } from "vitest";
import { StravaConnector } from "@/modules/integrations/strava";

describe("StravaConnector", () => {
  const clientId = "test-client-id";
  const clientSecret = "test-client-secret";
  const refreshToken = "test-refresh-token";
  let connector: StravaConnector;

  beforeEach(() => {
    vi.clearAllMocks();
    connector = new StravaConnector(clientId, clientSecret, refreshToken);
  });

  it("should refresh the OAuth token before fetching activities", async () => {
    const mockTokenResponse = {
      access_token: "new-access-token",
    };

    const mockActivitiesResponse: unknown[] = [];

    global.fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => mockTokenResponse,
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => mockActivitiesResponse,
      } as Response);

    await connector.fetchActivities("2024-01-15");

    expect(fetch).toHaveBeenNthCalledWith(
      1,
      "https://www.strava.com/oauth/token",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining("grant_type=refresh_token"),
      })
    );
  });

  it("should fetch activities with correct after/before timestamps", async () => {
    const mockTokenResponse = { access_token: "new-access-token" };
    const mockActivitiesResponse: unknown[] = [];

    global.fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => mockTokenResponse,
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => mockActivitiesResponse,
      } as Response);

    await connector.fetchActivities("2024-01-15");

    const activitiesCall = (fetch as ReturnType<typeof vi.fn>).mock.calls[1];
    const url = activitiesCall[0] as string;

    // after = start of 2024-01-15 UTC, before = start of 2024-01-16 UTC
    const after = Math.floor(new Date("2024-01-15T00:00:00Z").getTime() / 1000);
    const before = Math.floor(new Date("2024-01-16T00:00:00Z").getTime() / 1000);

    expect(url).toContain(`after=${after}`);
    expect(url).toContain(`before=${before}`);
  });

  it("should return NormalizedActivity[] with activity data", async () => {
    const mockTokenResponse = { access_token: "new-access-token" };
    const mockActivitiesResponse = [
      {
        id: 12345,
        name: "Morning Run",
        type: "Run",
        distance: 5000,
        moving_time: 1800,
        start_date: "2024-01-15T07:00:00Z",
        average_heartrate: 150,
        map: { summary_polyline: "abc123polyline" },
      },
    ];

    global.fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => mockTokenResponse,
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => mockActivitiesResponse,
      } as Response);

    const activities = await connector.fetchActivities("2024-01-15");

    expect(activities).toHaveLength(1);
    expect(activities[0]).toMatchObject({
      date: "2024-01-15",
      source: "strava",
      type: "run",
      data: {
        id: 12345,
        name: "Morning Run",
        activityType: "Run",
        distanceMeters: 5000,
        movingTimeSeconds: 1800,
        startTime: "2024-01-15T07:00:00Z",
        averageHeartrate: 150,
        polyline: "abc123polyline",
      },
    });
  });

  it("should lowercase the activity type", async () => {
    const mockTokenResponse = { access_token: "new-access-token" };
    const mockActivitiesResponse = [
      {
        id: 1,
        name: "Bike Ride",
        type: "Ride",
        distance: 20000,
        moving_time: 3600,
        start_date: "2024-01-15T08:00:00Z",
        average_heartrate: null,
        map: { summary_polyline: "" },
      },
    ];

    global.fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => mockTokenResponse,
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => mockActivitiesResponse,
      } as Response);

    const activities = await connector.fetchActivities("2024-01-15");

    expect(activities[0].type).toBe("ride");
  });

  it("should send refresh token credentials in the token request", async () => {
    const mockTokenResponse = { access_token: "new-access-token" };
    const mockActivitiesResponse: unknown[] = [];

    global.fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => mockTokenResponse,
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => mockActivitiesResponse,
      } as Response);

    await connector.fetchActivities("2024-01-15");

    const tokenCall = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = tokenCall[1].body as string;

    expect(body).toContain(`client_id=${clientId}`);
    expect(body).toContain(`client_secret=${clientSecret}`);
    expect(body).toContain(`refresh_token=${refreshToken}`);
    expect(body).toContain("grant_type=refresh_token");
  });

  it("should return empty array when no activities exist", async () => {
    const mockTokenResponse = { access_token: "new-access-token" };

    global.fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => mockTokenResponse,
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [],
      } as Response);

    const activities = await connector.fetchActivities("2024-01-15");

    expect(activities).toEqual([]);
  });

  it("should throw an error if token refresh fails", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 400,
      statusText: "Bad Request",
    } as Response);

    await expect(connector.fetchActivities("2024-01-15")).rejects.toThrow();
  });
});
