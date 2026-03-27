import { describe, it, expect } from "vitest";
import { parseSemanticLocationHistory } from "@/modules/integrations/google-maps";

describe("parseSemanticLocationHistory", () => {
  const sampleDate = "2024-01-15";

  const sampleTakeoutData = {
    timelineObjects: [
      {
        placeVisit: {
          location: {
            name: "Coffee Shop",
            address: "123 Main St",
            latitudeE7: 377774400,
            longitudeE7: -1224194000,
          },
          duration: {
            startTimestamp: "2024-01-15T08:00:00Z",
            endTimestamp: "2024-01-15T09:00:00Z",
          },
        },
      },
      {
        activitySegment: {
          startLocation: {
            latitudeE7: 377774400,
            longitudeE7: -1224194000,
          },
          endLocation: {
            latitudeE7: 378000000,
            longitudeE7: -1224000000,
          },
          duration: {
            startTimestamp: "2024-01-15T09:00:00Z",
            endTimestamp: "2024-01-15T09:30:00Z",
          },
          activityType: "IN_VEHICLE",
          distance: 5000,
        },
      },
    ],
  };

  it("should return NormalizedActivity[] from Takeout JSON", () => {
    const activities = parseSemanticLocationHistory(sampleTakeoutData, sampleDate);
    expect(activities).toHaveLength(2);
  });

  it("should parse placeVisit into a place_visit activity", () => {
    const activities = parseSemanticLocationHistory(sampleTakeoutData, sampleDate);
    const placeVisit = activities.find((a) => a.type === "place_visit");

    expect(placeVisit).toBeDefined();
    expect(placeVisit).toMatchObject({
      date: sampleDate,
      source: "google_maps",
      type: "place_visit",
      data: {
        name: "Coffee Shop",
        address: "123 Main St",
        latitude: 37.77744,
        longitude: -122.4194,
        startTime: "2024-01-15T08:00:00Z",
        endTime: "2024-01-15T09:00:00Z",
      },
    });
  });

  it("should parse activitySegment into a travel activity", () => {
    const activities = parseSemanticLocationHistory(sampleTakeoutData, sampleDate);
    const travel = activities.find((a) => a.type === "travel");

    expect(travel).toBeDefined();
    expect(travel).toMatchObject({
      date: sampleDate,
      source: "google_maps",
      type: "travel",
      data: {
        activityType: "IN_VEHICLE",
        startTime: "2024-01-15T09:00:00Z",
        endTime: "2024-01-15T09:30:00Z",
        distanceMeters: 5000,
        startLocation: {
          latitude: 37.77744,
          longitude: -122.4194,
        },
        endLocation: {
          latitude: 37.8,
          longitude: -122.4,
        },
      },
    });
  });

  it("should convert latitudeE7 and longitudeE7 to decimal by dividing by 1e7", () => {
    const data = {
      timelineObjects: [
        {
          placeVisit: {
            location: {
              name: "Test Place",
              address: "Test Address",
              latitudeE7: 512345678,
              longitudeE7: -45678901,
            },
            duration: {
              startTimestamp: "2024-01-15T10:00:00Z",
              endTimestamp: "2024-01-15T11:00:00Z",
            },
          },
        },
      ],
    };

    const activities = parseSemanticLocationHistory(data, sampleDate);
    const placeVisit = activities[0];

    expect(placeVisit.data.latitude).toBeCloseTo(51.2345678);
    expect(placeVisit.data.longitude).toBeCloseTo(-4.5678901);
  });

  it("should return empty array for empty timelineObjects", () => {
    const emptyData = { timelineObjects: [] };
    const activities = parseSemanticLocationHistory(emptyData, sampleDate);
    expect(activities).toEqual([]);
  });

  it("should handle data with only placeVisits", () => {
    const onlyPlaces = {
      timelineObjects: [
        {
          placeVisit: {
            location: {
              name: "Park",
              address: "Park Ave",
              latitudeE7: 400000000,
              longitudeE7: -740000000,
            },
            duration: {
              startTimestamp: "2024-01-15T12:00:00Z",
              endTimestamp: "2024-01-15T13:00:00Z",
            },
          },
        },
      ],
    };

    const activities = parseSemanticLocationHistory(onlyPlaces, sampleDate);
    expect(activities).toHaveLength(1);
    expect(activities[0].type).toBe("place_visit");
  });

  it("should handle data with only activitySegments", () => {
    const onlySegments = {
      timelineObjects: [
        {
          activitySegment: {
            startLocation: { latitudeE7: 400000000, longitudeE7: -740000000 },
            endLocation: { latitudeE7: 405000000, longitudeE7: -745000000 },
            duration: {
              startTimestamp: "2024-01-15T14:00:00Z",
              endTimestamp: "2024-01-15T14:30:00Z",
            },
            activityType: "WALKING",
            distance: 2000,
          },
        },
      ],
    };

    const activities = parseSemanticLocationHistory(onlySegments, sampleDate);
    expect(activities).toHaveLength(1);
    expect(activities[0].type).toBe("travel");
  });
});
