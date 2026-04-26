export interface NormalizedActivity {
  date: string; // YYYY-MM-DD
  source: "github" | "strava" | "google_maps" | "google_calendar" | "twitch" | "wechat" | "discord";
  type: string;
  data: Record<string, unknown>;
}

export interface IntegrationConnector {
  readonly name: string;
  fetchActivities(date: string): Promise<NormalizedActivity[]>;
}
