import type { NormalizedActivity } from "./types";

interface PlaceVisit {
  location: {
    name: string;
    address: string;
    latitudeE7: number;
    longitudeE7: number;
  };
  duration: {
    startTimestamp: string;
    endTimestamp: string;
  };
}

interface ActivitySegment {
  startLocation: {
    latitudeE7: number;
    longitudeE7: number;
  };
  endLocation: {
    latitudeE7: number;
    longitudeE7: number;
  };
  duration: {
    startTimestamp: string;
    endTimestamp: string;
  };
  activityType: string;
  distance: number;
}

interface TimelineObject {
  placeVisit?: PlaceVisit;
  activitySegment?: ActivitySegment;
}

interface TakeoutData {
  timelineObjects: TimelineObject[];
}

export function parseSemanticLocationHistory(
  data: TakeoutData,
  date: string
): NormalizedActivity[] {
  const activities: NormalizedActivity[] = [];

  for (const obj of data.timelineObjects) {
    if (obj.placeVisit) {
      const pv = obj.placeVisit;
      activities.push({
        date,
        source: "google_maps",
        type: "place_visit",
        data: {
          name: pv.location.name,
          address: pv.location.address,
          latitude: pv.location.latitudeE7 / 1e7,
          longitude: pv.location.longitudeE7 / 1e7,
          startTime: pv.duration.startTimestamp,
          endTime: pv.duration.endTimestamp,
        },
      });
    } else if (obj.activitySegment) {
      const seg = obj.activitySegment;
      activities.push({
        date,
        source: "google_maps",
        type: "travel",
        data: {
          activityType: seg.activityType,
          startTime: seg.duration.startTimestamp,
          endTime: seg.duration.endTimestamp,
          distanceMeters: seg.distance,
          startLocation: {
            latitude: seg.startLocation.latitudeE7 / 1e7,
            longitude: seg.startLocation.longitudeE7 / 1e7,
          },
          endLocation: {
            latitude: seg.endLocation.latitudeE7 / 1e7,
            longitude: seg.endLocation.longitudeE7 / 1e7,
          },
        },
      });
    }
  }

  return activities;
}
