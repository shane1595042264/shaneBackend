import { describe, it, expect, vi } from "vitest";

// Mock all external dependencies to avoid needing a real DB / API
vi.mock("@/modules/shared/llm", () => ({ generateText: vi.fn() }));
vi.mock("@/modules/shared/embeddings", () => ({ embed: vi.fn() }));
vi.mock("@/modules/shared/vector-search", () => ({
  findSimilarEntries: vi.fn(),
  findRelevantFacts: vi.fn(),
}));
vi.mock("@/modules/journal/voice-profile", () => ({
  getLatestVoiceProfile: vi.fn(),
}));
vi.mock("@/db/client", () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
  },
}));
vi.mock("@/db/schema", () => ({
  activities: {},
  diaryEntries: {},
  summaries: {},
}));
vi.mock("drizzle-orm", () => ({
  eq: vi.fn(),
  desc: vi.fn(),
  and: vi.fn(),
  lte: vi.fn(),
  gte: vi.fn(),
  or: vi.fn(),
}));
vi.mock("@/modules/integrations/geocode", () => ({
  batchReverseGeocode: vi.fn().mockResolvedValue(["Deep Ellum, Dallas", "Uptown, Dallas"]),
}));

import {
  formatActivitiesForPrompt,
  buildGenerationPrompt,
  clusterLocationPings,
  type GenerationContext,
} from "@/modules/journal/generator";
import type { NormalizedActivity } from "@/modules/integrations/types";

// -----------------------------------------------------------------------
// Sample data
// -----------------------------------------------------------------------

const sampleActivities: NormalizedActivity[] = [
  // google_maps
  {
    date: "2025-01-15",
    source: "google_maps",
    type: "visit",
    data: { name: "Blue Bottle Coffee", address: "123 Main St" },
  },
  // strava
  {
    date: "2025-01-15",
    source: "strava",
    type: "run",
    data: { name: "Morning Run", distanceMeters: 5200, movingTimeSeconds: 1800 },
  },
  // github
  {
    date: "2025-01-15",
    source: "github",
    type: "commit",
    data: { repo: "user/my-project", message: "feat: add new feature", sha: "abc123" },
  },
  // google_calendar
  {
    date: "2025-01-15",
    source: "google_calendar",
    type: "event",
    data: { summary: "Team standup", start: "09:00", end: "09:30" },
  },
];

const sampleContext: GenerationContext = {
  date: "2025-01-15",
  activitiesText: "Went for a run. Had coffee at Blue Bottle.",
  yearlySummary: "A year of growth and exploration.",
  monthlySummary: "January has been productive.",
  weeklySummary: "This week I focused on fitness.",
  yesterdayEntry: "Yesterday I stayed home and read.",
  similarEntries: [
    { date: "2024-06-10", content: "Another great run today." },
    { date: "2024-03-22", content: "Coffee and coding." },
  ],
  relevantFacts: ["I prefer morning runs.", "Blue Bottle is my favorite café."],
};

// -----------------------------------------------------------------------
// formatActivitiesForPrompt tests
// -----------------------------------------------------------------------

describe("formatActivitiesForPrompt", () => {
  it("should include google_maps location names", async () => {
    const output = await formatActivitiesForPrompt(sampleActivities, "2025-01-15");
    expect(output).toContain("Blue Bottle Coffee");
  });

  it("should include strava workout data", async () => {
    const output = await formatActivitiesForPrompt(sampleActivities, "2025-01-15");
    expect(output).toContain("Morning Run");
  });

  it("should include strava distance", async () => {
    const output = await formatActivitiesForPrompt(sampleActivities, "2025-01-15");
    // Distance should appear in some form
    expect(output).toContain("5.2");
  });

  it("should include github commit messages", async () => {
    const output = await formatActivitiesForPrompt(sampleActivities, "2025-01-15");
    expect(output).toContain("feat: add new feature");
  });

  it("should include github repo name", async () => {
    const output = await formatActivitiesForPrompt(sampleActivities, "2025-01-15");
    expect(output).toContain("user/my-project");
  });

  it("should include calendar event summary", async () => {
    const output = await formatActivitiesForPrompt(sampleActivities, "2025-01-15");
    expect(output).toContain("Team standup");
  });

  it("should include calendar event times", async () => {
    const output = await formatActivitiesForPrompt(sampleActivities, "2025-01-15");
    expect(output).toContain("09:00");
  });

  it("should group activities by source with section labels", async () => {
    const output = await formatActivitiesForPrompt(sampleActivities, "2025-01-15");
    // Should have some kind of grouping / section labels
    const lower = output.toLowerCase();
    const hasLocations = lower.includes("location") || lower.includes("places") || lower.includes("maps");
    const hasWorkouts = lower.includes("workout") || lower.includes("strava") || lower.includes("exercise") || lower.includes("run");
    const hasCommits = lower.includes("commit") || lower.includes("github") || lower.includes("code");
    const hasEvents = lower.includes("event") || lower.includes("calendar") || lower.includes("meeting");
    expect(hasLocations && hasWorkouts && hasCommits && hasEvents).toBe(true);
  });

  it("should return a non-empty string for empty activities", async () => {
    const output = await formatActivitiesForPrompt([], "2025-01-15");
    expect(typeof output).toBe("string");
  });

  it("should handle activities with only one source", async () => {
    const githubOnly = sampleActivities.filter((a) => a.source === "github");
    const output = await formatActivitiesForPrompt(githubOnly, "2025-01-15");
    expect(output).toContain("feat: add new feature");
  });

  it("should reverse geocode location pings into place names", async () => {
    const pings: NormalizedActivity[] = [];
    // Create pings at a location for 30 minutes (enough to form a cluster)
    for (let i = 0; i < 10; i++) {
      pings.push({
        date: "2025-01-15",
        source: "google_maps",
        type: "location_ping",
        data: {
          latitude: 32.7847 + Math.random() * 0.001,
          longitude: -96.7853 + Math.random() * 0.001,
          timestamp: new Date(2025, 0, 15, 10, i * 3).toISOString(),
        },
      });
    }
    const output = await formatActivitiesForPrompt(pings, "2025-01-15");
    // Should contain the mocked geocoded name, not raw coordinate counts
    expect(output).toContain("Deep Ellum, Dallas");
    expect(output).not.toContain("location pings recorded");
  });
});

// -----------------------------------------------------------------------
// clusterLocationPings tests
// -----------------------------------------------------------------------

describe("clusterLocationPings", () => {
  it("should group nearby pings into a single cluster", () => {
    const pings: NormalizedActivity[] = [];
    for (let i = 0; i < 5; i++) {
      pings.push({
        date: "2025-01-15",
        source: "google_maps",
        type: "location_ping",
        data: {
          latitude: 32.7847,
          longitude: -96.7853,
          timestamp: new Date(2025, 0, 15, 10, i * 5).toISOString(),
        },
      });
    }
    const clusters = clusterLocationPings(pings);
    expect(clusters.length).toBe(1);
    expect(clusters[0].pingCount).toBe(5);
    expect(clusters[0].durationMinutes).toBe(20);
  });

  it("should split distant pings into separate clusters", () => {
    const pings: NormalizedActivity[] = [
      // Cluster 1: downtown (30 min)
      ...Array.from({ length: 4 }, (_, i) => ({
        date: "2025-01-15",
        source: "google_maps" as const,
        type: "location_ping",
        data: {
          latitude: 32.7847,
          longitude: -96.7853,
          timestamp: new Date(2025, 0, 15, 10, i * 10).toISOString(),
        },
      })),
      // Cluster 2: 5km away (30 min)
      ...Array.from({ length: 4 }, (_, i) => ({
        date: "2025-01-15",
        source: "google_maps" as const,
        type: "location_ping",
        data: {
          latitude: 32.83,
          longitude: -96.75,
          timestamp: new Date(2025, 0, 15, 14, i * 10).toISOString(),
        },
      })),
    ];
    const clusters = clusterLocationPings(pings);
    expect(clusters.length).toBe(2);
  });

  it("should filter out short stops below minMinutes", () => {
    const pings: NormalizedActivity[] = [
      {
        date: "2025-01-15",
        source: "google_maps",
        type: "location_ping",
        data: {
          latitude: 32.7847,
          longitude: -96.7853,
          timestamp: new Date(2025, 0, 15, 10, 0).toISOString(),
        },
      },
      {
        date: "2025-01-15",
        source: "google_maps",
        type: "location_ping",
        data: {
          latitude: 32.7847,
          longitude: -96.7853,
          timestamp: new Date(2025, 0, 15, 10, 2).toISOString(),
        },
      },
    ];
    // 2 minutes — should be filtered out (default minMinutes = 5)
    const clusters = clusterLocationPings(pings);
    expect(clusters.length).toBe(0);
  });

  it("should return empty array for no pings", () => {
    expect(clusterLocationPings([])).toEqual([]);
  });
});

// -----------------------------------------------------------------------
// buildGenerationPrompt tests
// -----------------------------------------------------------------------

describe("buildGenerationPrompt", () => {
  it("should include activities text", () => {
    const prompt = buildGenerationPrompt(sampleContext);
    expect(prompt).toContain(sampleContext.activitiesText);
  });

  it("should include yearly summary", () => {
    const prompt = buildGenerationPrompt(sampleContext);
    expect(prompt).toContain(sampleContext.yearlySummary);
  });

  it("should include monthly summary", () => {
    const prompt = buildGenerationPrompt(sampleContext);
    expect(prompt).toContain(sampleContext.monthlySummary);
  });

  it("should include weekly summary", () => {
    const prompt = buildGenerationPrompt(sampleContext);
    expect(prompt).toContain(sampleContext.weeklySummary);
  });

  it("should include yesterday's entry", () => {
    const prompt = buildGenerationPrompt(sampleContext);
    expect(prompt).toContain(sampleContext.yesterdayEntry!);
  });

  it("should include similar past entries content", () => {
    const prompt = buildGenerationPrompt(sampleContext);
    expect(prompt).toContain("Another great run today.");
    expect(prompt).toContain("Coffee and coding.");
  });

  it("should include relevant facts", () => {
    const prompt = buildGenerationPrompt(sampleContext);
    expect(prompt).toContain("I prefer morning runs.");
    expect(prompt).toContain("Blue Bottle is my favorite café.");
  });

  it("should include the date", () => {
    const prompt = buildGenerationPrompt(sampleContext);
    expect(prompt).toContain("2025-01-15");
  });

  it("should instruct writing in first person flowing prose", () => {
    const prompt = buildGenerationPrompt(sampleContext);
    const lower = prompt.toLowerCase();
    expect(lower).toContain("first person");
  });

  it("should handle missing optional fields gracefully", () => {
    const minimalContext: GenerationContext = {
      date: "2025-01-15",
      activitiesText: "Did some stuff.",
      yearlySummary: null,
      monthlySummary: null,
      weeklySummary: null,
      yesterdayEntry: null,
      similarEntries: [],
      relevantFacts: [],
    };
    expect(() => buildGenerationPrompt(minimalContext)).not.toThrow();
    const prompt = buildGenerationPrompt(minimalContext);
    expect(prompt).toContain("Did some stuff.");
  });
});
