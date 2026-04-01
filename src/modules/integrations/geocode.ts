/**
 * Reverse geocoding using OpenStreetMap Nominatim (free, no API key).
 * Rate limited to 1 req/sec per Nominatim usage policy.
 */

interface NominatimResponse {
  display_name: string;
  address: {
    road?: string;
    neighbourhood?: string;
    suburb?: string;
    city?: string;
    town?: string;
    village?: string;
    county?: string;
    state?: string;
    country?: string;
    [key: string]: string | undefined;
  };
}

export interface GeocodedLocation {
  name: string; // e.g. "Deep Ellum, Dallas" or "Main St, Dallas"
  latitude: number;
  longitude: number;
}

const NOMINATIM_URL = "https://nominatim.openstreetmap.org/reverse";

/**
 * Reverse geocode a lat/lon pair into a human-readable place name.
 * Returns a short, meaningful name like "Deep Ellum, Dallas" or "North Dallas".
 */
export async function reverseGeocode(
  lat: number,
  lon: number
): Promise<string> {
  try {
    const url = `${NOMINATIM_URL}?lat=${lat}&lon=${lon}&format=json&addressdetails=1&zoom=16`;
    const res = await fetch(url, {
      headers: { "User-Agent": "ShaneLiPersonalWebsite/1.0" },
    });

    if (!res.ok) {
      return `${lat.toFixed(3)}, ${lon.toFixed(3)}`;
    }

    const data = (await res.json()) as NominatimResponse;
    return formatPlaceName(data.address);
  } catch {
    return `${lat.toFixed(3)}, ${lon.toFixed(3)}`;
  }
}

/**
 * Build a short, human-readable name from Nominatim address components.
 * Prefers neighbourhood/suburb + city, falls back to road + city.
 */
function formatPlaceName(addr: NominatimResponse["address"]): string {
  const city = addr.city || addr.town || addr.village || addr.county || "";
  const local =
    addr.neighbourhood || addr.suburb || addr.road || "";

  if (local && city) return `${local}, ${city}`;
  if (city) return city;
  if (local) return local;
  return addr.state || "Unknown location";
}

/**
 * Batch reverse geocode with rate limiting (1 req/sec for Nominatim).
 */
export async function batchReverseGeocode(
  coords: Array<{ latitude: number; longitude: number }>
): Promise<string[]> {
  const results: string[] = [];
  for (let i = 0; i < coords.length; i++) {
    if (i > 0) {
      await new Promise((resolve) => setTimeout(resolve, 1100));
    }
    results.push(await reverseGeocode(coords[i].latitude, coords[i].longitude));
  }
  return results;
}
