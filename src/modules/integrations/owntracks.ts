import type { NormalizedActivity } from "./types";
import { db } from "@/db/client";
import { activities } from "@/db/schema";

/**
 * OwnTracks HTTP webhook payload.
 * Docs: https://owntracks.org/booklet/tech/http/
 */
interface OwnTracksPayload {
  _type: "location" | "transition" | "waypoint" | "lwt";
  lat: number;
  lon: number;
  tst: number; // Unix timestamp
  acc?: number; // Accuracy in meters
  alt?: number; // Altitude
  vel?: number; // Velocity km/h
  batt?: number; // Battery percentage
  tid?: string; // Tracker ID (2 chars)
  conn?: string; // Connection type (w=wifi, m=mobile)
  SSID?: string; // WiFi SSID if on wifi
  desc?: string; // Waypoint description (for transition events)
  event?: string; // "enter" or "leave" (for transition events)
}

function toDateString(unixTimestamp: number): string {
  return new Date(unixTimestamp * 1000).toISOString().split("T")[0];
}

function toISOString(unixTimestamp: number): string {
  return new Date(unixTimestamp * 1000).toISOString();
}

/**
 * Process an OwnTracks location ping and store it as a normalized activity.
 */
export async function processLocationPing(
  payload: OwnTracksPayload
): Promise<NormalizedActivity | null> {
  // Only process location updates
  if (payload._type !== "location") {
    return null;
  }

  const date = toDateString(payload.tst);

  const activity: NormalizedActivity = {
    date,
    source: "google_maps", // Reuse the same source so journal generator picks it up
    type: "location_ping",
    data: {
      latitude: payload.lat,
      longitude: payload.lon,
      timestamp: toISOString(payload.tst),
      accuracy: payload.acc ?? null,
      altitude: payload.alt ?? null,
      velocity: payload.vel ?? null,
      battery: payload.batt ?? null,
      connection: payload.conn ?? null,
      ssid: payload.SSID ?? null,
    },
  };

  await db
    .insert(activities)
    .values({
      date: activity.date,
      source: activity.source,
      type: activity.type,
      data: activity.data,
    })
    .onConflictDoNothing();

  return activity;
}

/**
 * Process an OwnTracks waypoint transition (enter/leave a region).
 */
export async function processTransition(
  payload: OwnTracksPayload
): Promise<NormalizedActivity | null> {
  if (payload._type !== "transition") {
    return null;
  }

  const date = toDateString(payload.tst);

  const activity: NormalizedActivity = {
    date,
    source: "google_maps",
    type: payload.event === "enter" ? "place_enter" : "place_leave",
    data: {
      name: payload.desc ?? "Unknown",
      latitude: payload.lat,
      longitude: payload.lon,
      timestamp: toISOString(payload.tst),
      event: payload.event ?? "unknown",
    },
  };

  await db
    .insert(activities)
    .values({
      date: activity.date,
      source: activity.source,
      type: activity.type,
      data: activity.data,
    })
    .onConflictDoNothing();

  return activity;
}
