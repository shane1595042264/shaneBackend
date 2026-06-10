/**
 * Automatic Unsplash photo fill (SHAN-280, extracted from the SHAN-279
 * route). One photo per distinct uncovered location: a location's photo
 * covers every day sharing it, since photos render as backgrounds. Called
 * by the manual unsplash-fill route AND best-effort after every itinerary
 * write (consolidate, manual PUT, suggestion approval), so any day with a
 * specified city gets its photo automatically.
 */
import type { TripItinerary } from "./consolidator";
import { listPhotos, insertUnsplashPhoto, type TripGroupPhotoMeta } from "./photos-repo";
import { searchUnsplashPhoto } from "./unsplash";

export interface FillResult {
  created: TripGroupPhotoMeta[];
  skipped: { day: number; reason: string }[];
}

export async function autoFillLocationPhotos(
  groupId: string,
  itinerary: TripItinerary,
): Promise<FillResult> {
  const existing = await listPhotos(groupId);
  const dayLocation = new Map(itinerary.days.map((d) => [d.day, d.location]));
  const coveredLocations = new Set(
    existing.map((p) => dayLocation.get(p.day)).filter((l): l is string => !!l),
  );
  const seenLocations = new Set<string>();
  const targets = itinerary.days.filter((d) => {
    if (!d.location || coveredLocations.has(d.location) || seenLocations.has(d.location)) {
      return false;
    }
    seenLocations.add(d.location);
    return true;
  });

  const created: TripGroupPhotoMeta[] = [];
  const skipped: { day: number; reason: string }[] = [];
  for (const d of targets) {
    try {
      const hit = await searchUnsplashPhoto(d.location as string);
      if (!hit) {
        skipped.push({ day: d.day, reason: "no Unsplash results" });
        continue;
      }
      created.push(
        await insertUnsplashPhoto({
          groupId,
          day: d.day,
          externalUrl: hit.url,
          attribution: hit.attribution,
        }),
      );
    } catch (err) {
      skipped.push({ day: d.day, reason: (err as Error).message });
    }
  }
  return { created, skipped };
}
