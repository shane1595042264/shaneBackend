export interface NormalizedActivity {
  date: string; // YYYY-MM-DD
  source: "github" | "strava" | "google_maps" | "google_calendar";
  type: string;
  data: Record<string, unknown>;
}

export interface IntegrationConnector {
  fetchActivities(date: string): Promise<NormalizedActivity[]>;
}
